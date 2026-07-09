
resource "aws_rds_cluster" "this" {
  cluster_identifier                  = "${local.app}-${local.org}-db"
  engine                              = "aurora-postgresql"
  engine_version                      = "16.11"
  engine_mode                         = "provisioned"
  database_name                       = null
  master_username                     = "postgres"
  manage_master_user_password         = true
  db_cluster_parameter_group_name     = "default.aurora-postgresql16"
  db_subnet_group_name                = aws_db_subnet_group.db.name
  vpc_security_group_ids              = [aws_security_group.db.id]
  storage_encrypted                   = true
  kms_key_id                          = aws_kms_key.db.arn
  deletion_protection                 = true
  skip_final_snapshot                 = true
  backup_retention_period             = 7
  preferred_backup_window             = "03:33-04:03"
  preferred_maintenance_window        = "sun:09:00-sun:09:30"
  copy_tags_to_snapshot               = true
  iam_database_authentication_enabled = false
  monitoring_interval                 = 60
  monitoring_role_arn                 = aws_iam_role.rds_monitoring.arn
  enable_global_write_forwarding      = false
  enable_local_write_forwarding       = false

  performance_insights_enabled          = true
  performance_insights_kms_key_id       = aws_kms_key.db.arn
  performance_insights_retention_period = 7

  serverlessv2_scaling_configuration {
    min_capacity = 0.5
    max_capacity = 64
  }
}

resource "aws_rds_cluster_instance" "instance_1" {
  cluster_identifier                    = aws_rds_cluster.this.id
  identifier                            = "${local.app}-${local.org}-db-instance-1"
  instance_class                        = "db.serverless"
  engine                                = aws_rds_cluster.this.engine
  engine_version                        = aws_rds_cluster.this.engine_version
  db_subnet_group_name                  = aws_rds_cluster.this.db_subnet_group_name
  db_parameter_group_name               = "default.aurora-postgresql16"
  publicly_accessible                   = false # private subnets, set to false for better security
  auto_minor_version_upgrade            = true
  ca_cert_identifier                    = "rds-ca-rsa2048-g1"
  monitoring_interval                   = 60
  monitoring_role_arn                   = aws_iam_role.rds_monitoring.arn
  performance_insights_enabled          = true
  performance_insights_kms_key_id       = aws_kms_key.db.arn
  performance_insights_retention_period = 7
  preferred_maintenance_window          = "sat:04:57-sat:05:27"
  promotion_tier                        = 1
}

resource "aws_rds_cluster_instance" "instance_2" {
  cluster_identifier                    = aws_rds_cluster.this.id
  identifier                            = "${local.app}-${local.org}-db-instance-2"
  instance_class                        = "db.serverless"
  engine                                = aws_rds_cluster.this.engine
  engine_version                        = aws_rds_cluster.this.engine_version
  db_subnet_group_name                  = aws_rds_cluster.this.db_subnet_group_name
  db_parameter_group_name               = "default.aurora-postgresql16"
  publicly_accessible                   = false # private subnets, set to false for better security
  auto_minor_version_upgrade            = true
  ca_cert_identifier                    = "rds-ca-rsa2048-g1"
  monitoring_interval                   = 60
  monitoring_role_arn                   = aws_iam_role.rds_monitoring.arn
  performance_insights_enabled          = true
  performance_insights_kms_key_id       = aws_kms_key.db.arn
  performance_insights_retention_period = 7
  preferred_maintenance_window          = "fri:07:19-fri:07:49"
  promotion_tier                        = 1
}

# Subnet Group for the database, matching the subnets of the EC2 instance
resource "aws_db_subnet_group" "db" {
  name       = "${local.org}-${local.app}-db-subnet-group"
  subnet_ids = [aws_subnet.public_zone_1.id, aws_subnet.public_zone_2.id]

  tags = {
    Name = "${local.org}-${local.app}-db-subnet-group"
  }
}

# Security Group for the database, allowing PostgreSQL ingress from the EC2 instance
resource "aws_security_group" "db" {
  name   = "${local.org}-${local.app}-db-sg"
  vpc_id = data.aws_vpc.default.id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.ec2.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${local.org}-${local.app}-db-sg"
  }
}

# KMS Key for database cluster storage encryption
resource "aws_kms_key" "db" {
  description             = "KMS key for Aurora PostgreSQL cluster encryption"
  deletion_window_in_days = 10

  tags = {
    Name = "${local.org}-${local.app}-db-kms-key"
  }
}

# IAM Monitoring Role and Policy Attachment for RDS Enhanced Monitoring
resource "aws_iam_role" "rds_monitoring" {
  name = "${local.org}-${local.app}-rds-monitoring-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "monitoring.rds.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "rds_monitoring" {
  role       = aws_iam_role.rds_monitoring.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

