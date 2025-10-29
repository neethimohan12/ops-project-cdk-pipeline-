import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as autoscaling from "aws-cdk-lib/aws-autoscaling";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";

export class OpsCdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    /** Context parameters */
    const vpcCidr = this.node.tryGetContext("vpcCidr") || "10.20.0.0/16";
    const instanceType = this.node.tryGetContext("instanceType") || "t2.micro";
    const desiredCapacity = this.node.tryGetContext("desiredCapacity") || 2;
    const minCapacity = this.node.tryGetContext("minCapacity") || 1;
    const maxCapacity = this.node.tryGetContext("maxCapacity") || 4;
    const dbEngine = this.node.tryGetContext("dbEngine") || "postgres";
    const dbStorage = this.node.tryGetContext("dbStorage") || 20;
    const dbInstanceType =
      this.node.tryGetContext("dbInstanceType") || "t3.micro";

    /** VPC */
    const vpc = new ec2.Vpc(this, "ProjectVPC", {
      cidr: vpcCidr,
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: "PublicSubnet",
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: "PrivateSubnet",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    });

    /** Security Groups */
    const albSG = new ec2.SecurityGroup(this, "ALBSG", {
      vpc,
      allowAllOutbound: true,
      description: "ALB security group",
    });
    albSG.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "Allow HTTP");

    const ec2SG = new ec2.SecurityGroup(this, "EC2SG", {
      vpc,
      allowAllOutbound: true,
      description: "EC2 security group",
    });
    ec2SG.addIngressRule(albSG, ec2.Port.tcp(80), "Allow HTTP from ALB");

    const dbSG = new ec2.SecurityGroup(this, "DBSG", {
      vpc,
      allowAllOutbound: false,
      description: "Database security group",
    });
    dbSG.addIngressRule(ec2SG, ec2.Port.tcp(5432), "Allow PostgreSQL from EC2");

    /** Auto Scaling Group (using Launch Template) */
    const launchTemplate = new ec2.LaunchTemplate(this, "WebLaunchTemplate", {
      instanceType: new ec2.InstanceType(instanceType),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: ec2SG, 
    });

    const asg = new autoscaling.AutoScalingGroup(this, "WebASG", {
      vpc,
      minCapacity,
      maxCapacity,
      desiredCapacity,
      launchTemplate,
    });

    /** Application Load Balancer */
    const alb = new elbv2.ApplicationLoadBalancer(this, "ALB", {
      vpc,
      internetFacing: true,
      securityGroup: albSG,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    const listener = alb.addListener("Listener", {
      port: 80,
      open: true,
    });

    listener.addTargets("TargetGroup", {
      port: 80,
      targets: [asg],
      healthCheck: {
        path: "/health",
        interval: cdk.Duration.seconds(60),
      },
    });

    /** RDS Database with Secrets Manager */
    const dbSecret = new secretsmanager.Secret(this, "DBSecret", {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: "dbadmin" }),
        generateStringKey: "password",
        excludePunctuation: true,
      },
    });

    const rdsEngine =
      dbEngine.toLowerCase() === "mysql"
        ? rds.DatabaseInstanceEngine.mysql({
            version: rds.MysqlEngineVersion.VER_8_0_33,
          })
        : rds.DatabaseInstanceEngine.postgres({
            version: rds.PostgresEngineVersion.VER_15,
          });

    const db = new rds.DatabaseInstance(this, "Database", {
      engine: rdsEngine,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      credentials: rds.Credentials.fromSecret(dbSecret),
      multiAz: false,
      allocatedStorage: dbStorage,
      instanceType: new ec2.InstanceType(dbInstanceType),
      securityGroups: [dbSG],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deletionProtection: false,
    });

    /** Outputs */
    new cdk.CfnOutput(this, "ALB-DNS", { value: alb.loadBalancerDnsName });
    new cdk.CfnOutput(this, "RDS-Endpoint", {
      value: db.dbInstanceEndpointAddress,
    });
  }
}
