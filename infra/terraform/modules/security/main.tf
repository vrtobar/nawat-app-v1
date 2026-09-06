# =============================================================================
# MODULE: SECURITY GROUPS
#
# All groups live here so the relationships between them are visible in one
# place. They belong to the foundation layer because the application layer
# references their IDs — keeping them stable across application destroy and
# recreate cycles.
#
# Ingress is source-restricted and, wherever possible, matches on another
# security group rather than a CIDR: that survives ECS tasks being replaced
# with new IPs. Egress is open on all of them; the ingress rules are what
# actually constrain reachability.
# =============================================================================

# -----------------------------------------------------------------------------
# ALB
#
# Port 80 is open alongside 443 so the listener can answer with a redirect.
# Blocking it entirely would give anyone typing a bare hostname a connection
# refused rather than an upgrade to HTTPS.
# -----------------------------------------------------------------------------
resource "aws_security_group" "alb" {
  name        = "${var.prefix}-alb"
  description = "ALB - accepts HTTPS/HTTP from the internet, forwards to ECS"
  vpc_id      = var.vpc_id

  ingress {
    description = "HTTPS from internet"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTP from internet, redirected to HTTPS by the listener"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.prefix}-alb" }
}

# -----------------------------------------------------------------------------
# ECS API — NestJS
#
# Outbound needs: RDS 5432, Redis 6379, and 443 through NAT for Auth0 JWKS
# and Management API calls.
# -----------------------------------------------------------------------------
resource "aws_security_group" "ecs_api" {
  name        = "${var.prefix}-ecs-api"
  description = "ECS NestJS API - accepts traffic from the ALB only"
  vpc_id      = var.vpc_id

  ingress {
    description     = "NestJS from ALB"
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.prefix}-ecs-api" }
}

# -----------------------------------------------------------------------------
# ECS Web — Next.js
#
# Server-side rendering calls the API through api.{env}.nahuat.com, which
# resolves to the ALB, so that traffic re-enters via the ALB security group
# rather than going host to host.
# -----------------------------------------------------------------------------
resource "aws_security_group" "ecs_web" {
  name        = "${var.prefix}-ecs-web"
  description = "ECS Next.js web - accepts traffic from the ALB only"
  vpc_id      = var.vpc_id

  ingress {
    description     = "Next.js from ALB"
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.prefix}-ecs-web" }
}

# -----------------------------------------------------------------------------
# RDS PostgreSQL
#
# Private subnets only, publicly_accessible = false on the instance. Two
# separate ingress rules because a single rule cannot list multiple source
# security groups.
# -----------------------------------------------------------------------------
resource "aws_security_group" "rds" {
  name        = "${var.prefix}-rds"
  description = "RDS PostgreSQL - accepts connections from ECS API and Lambda only"
  vpc_id      = var.vpc_id

  ingress {
    description     = "PostgreSQL from ECS API"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs_api.id]
  }

  ingress {
    description     = "PostgreSQL from Lambda consumers"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.lambda.id]
  }

  # The bastion, which exists so a human can reach this database at all: RDS is
  # publicly_accessible = false in private subnets, and ECS Exec is disabled, so
  # without this there is no path from a laptop to staging or production data.
  #
  # Unconditional, while the instance itself is controlled by enable_bastion. A
  # security group with no member ENI is unreachable — nothing carries it, so
  # nothing can open a connection through it — which means this rule opens no
  # path on its own when an environment has no bastion. What it buys is that the
  # shared module applies identically in both environments, with no dynamic
  # block and no apply-order dependency inside foundation.
  ingress {
    description     = "PostgreSQL from the SSM bastion"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.bastion.id]
  }

  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.prefix}-rds" }
}

# -----------------------------------------------------------------------------
# ElastiCache Valkey
#
# ONLY THE API REACHES REDIS. There was a second ingress admitting the Lambda
# group, written for the cache-invalidation consumer that ADR 19 deleted; the
# media consumer that replaced it reads S3 and Postgres and no cache, so the
# rule was removed rather than left admitting a group with no reason to be
# here. A queue consumer needing Redis would add it back with its own name on
# it.
#
# There is no AUTH token either: access is controlled by VPC placement and this
# group alone. See the backlog entry on Redis AUTH.
# -----------------------------------------------------------------------------
resource "aws_security_group" "redis" {
  name        = "${var.prefix}-redis"
  description = "ElastiCache Valkey - accepts connections from the ECS API"
  vpc_id      = var.vpc_id

  ingress {
    description     = "Redis from ECS API (rate limiting, caching)"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs_api.id]
  }

  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.prefix}-redis" }
}

# -----------------------------------------------------------------------------
# Lambda consumers
#
# No ingress rules, deliberately: SQS does not deliver over the VPC network.
# The event source mapping invokes the function through the Lambda service
# plane, so nothing needs to reach these ENIs inbound.
#
# Outbound covers RDS and 443 via NAT, and a real consumer now uses both. The
# media consumer reads Postgres directly and reaches S3, Secrets Manager and
# SQS over 443. Only S3 has a gateway endpoint and it is behind
# enable_vpc_endpoints, so the other two traverse NAT whether or not that is on.
#
# REDIS IS NOT IN THAT LIST ANY MORE. The egress was written when this group
# also had ingress to the Redis group, for the cache-invalidation consumer ADR
# 19 deleted; that ingress is gone and the media consumer touches no cache. The
# note that used to sit here said no consumer used this egress at all, which
# stopped being true when modules/messaging placed the first real function.
#
# ⚠️ THE `description` STRINGS BELOW STILL SAY REDIS AND THAT IS DELIBERATE.
# A security group's description cannot be modified in place — Terraform plans
# `must be replaced` for a one-word edit, measured on staging's foundation
# 2026-09-05. The Lambdas that carry this group are declared in the APPLICATION
# layer while the group itself is here, so a replacement would have to delete a
# group still attached to live ENIs in a layer this apply does not touch. The
# wording is wrong; correcting it is not worth a cross-layer replacement, and it
# will come right for free the next time an environment is built from nothing.
# -----------------------------------------------------------------------------
resource "aws_security_group" "lambda" {
  name        = "${var.prefix}-lambda"
  description = "Lambda consumers - VPC attached for RDS and Redis access"
  vpc_id      = var.vpc_id

  egress {
    description = "All outbound - RDS, Redis, and CloudFront API via NAT"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.prefix}-lambda" }
}

# -----------------------------------------------------------------------------
# SSM bastion
#
# NO INGRESS RULES AT ALL, and that is the design rather than an omission.
# Session Manager does not accept an inbound connection: the SSM agent on the
# instance dials out to the SSM service and the session is carried back over
# that outbound connection. So a bastion reachable only through SSM needs no
# open port, no public IP, and no key pair — there is nothing to scan for and
# nothing to brute force, which is the whole reason this replaces a classic
# jump host.
#
# Egress is open because the agent has to reach ssm, ssmmessages and
# ec2messages, and it does so through the application layer's NAT gateway
# rather than through VPC interface endpoints. Three endpoints would cost about
# $21/month for a path the NAT already serves, and the bastion only exists when
# the application layer — and therefore the NAT — does.
# -----------------------------------------------------------------------------
resource "aws_security_group" "bastion" {
  name        = "${var.prefix}-bastion"
  description = "SSM bastion - no ingress; outbound only, for Session Manager and RDS"
  vpc_id      = var.vpc_id

  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.prefix}-bastion" }
}
