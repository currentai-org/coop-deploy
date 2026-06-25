#
# Default VPC
#
data "aws_vpc" "default" {
  id = "vpc-01e9c4b40c6aadb30"
}

#
# ACM Certificate
#
resource "aws_acm_certificate" "cert" {
  domain_name       = local.domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_acm_certificate_validation" "cert" {
  certificate_arn = aws_acm_certificate.cert.arn
}


#
# Subnets
#
resource "aws_subnet" "public_zone_1" {
  vpc_id                  = data.aws_vpc.default.id
  cidr_block              = "10.0.48.0/20"
  availability_zone       = local.zone1
  map_public_ip_on_launch = true
  tags = {
    Name = "${local.org}-${local.app}-${local.zone1}"
  }
}

resource "aws_subnet" "public_zone_2" {
  vpc_id                  = data.aws_vpc.default.id
  cidr_block              = "10.0.64.0/20"
  availability_zone       = local.zone2
  map_public_ip_on_launch = true
  tags = {
    Name = "${local.org}-${local.app}-${local.zone2}"
  }
}


data "aws_ami" "amazon_ubuntu" {
  most_recent = true

  owners = ["099720109477"]

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-resolute-26.04-amd64-server-20260604"]
  }
}

#
# Security Group for EC2
#
resource "aws_security_group" "ec2" {
  name   = "${local.org}-${local.app}-ec2-sg"
  vpc_id = data.aws_vpc.default.id

  ingress {
    from_port       = 80
    to_port         = 80
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

#
# Security Group for ALB
#
resource "aws_security_group" "alb" {
  name   = "${local.org}-${local.app}-alb-sg"
  vpc_id = data.aws_vpc.default.id

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

#
# EC2 Instance
#
resource "tls_private_key" "key" {
  algorithm = "RSA"
  rsa_bits  = 4096
}

resource "aws_key_pair" "key_pair" {
  key_name   = "${local.org}-${local.app}-key"
  public_key = tls_private_key.key.public_key_openssh
}

resource "aws_instance" "app" {
  ami                    = data.aws_ami.amazon_ubuntu.id
  instance_type          = "t3.large"
  subnet_id              = aws_subnet.public_zone_1.id
  vpc_security_group_ids = [aws_security_group.ec2.id]
  key_name               = aws_key_pair.key_pair.key_name

  root_block_device {
    volume_size = 25
    volume_type = "gp3"
    # throughput            = 125
    # iops                  = 3000
    delete_on_termination = true
  }

  tags = {
    Name = "${local.org}-${local.app}-ec2"
  }
}

output "instance_public_ip" {
  value = aws_instance.app.public_ip
}

output "private_key" {
  value     = tls_private_key.key.private_key_pem
  sensitive = true
}

#
# ALB
#
resource "aws_lb" "app" {
  name               = "${local.org}-${local.app}-alb"
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = [aws_subnet.public_zone_1.id, aws_subnet.public_zone_2.id]
}

#
# Target Group pointing to Nginx on port 80
#
resource "aws_lb_target_group" "app" {
  name     = "${local.org}-${local.app}-tg-80"
  port     = 80
  protocol = "HTTP"
  vpc_id   = data.aws_vpc.default.id

  health_check {
    path = "/"
  }
}

#
# Attach instance to Target Group
#
resource "aws_lb_target_group_attachment" "app" {
  target_group_arn = aws_lb_target_group.app.arn
  target_id        = aws_instance.app.id
  port             = 80
}

#
# Listener :80 -> Redirects to HTTPS :443
#
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.app.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

#
# Listener :443 -> forward to Nginx on port 80
#
resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.app.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-2016-08"
  certificate_arn   = aws_acm_certificate_validation.cert.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}
