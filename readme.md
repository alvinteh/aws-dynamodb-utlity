# dynamodb-utility

This utility script helps perform tasks related to migrating DynamoDB tables across AWS accounts. It exports DynamoDB table configurations (excluding the data) and re-create those tables in another AWS account. It also helps enable PITR, create S3 exports and setup corresponding Glue jobs for each table.

## Prerequisites

* AWS account
* node 14.16.0+
* IAM user/role with the following permissions to execute the script:
    * Source account
        * dynamodb:DescribeTable
        * dynamodb:ExportTableToPointInTime
        * dynamodb:ListTables
        * dynamodb:UpdateContinuousBackups
        * dynamodb:UpdateTable
        * sts:AssumeRole
    * Destination account (IAM role only; script will assume role)
        * dynamodb:CreateTable
        * dynamodb:ListTables
        * s3:PutObject
        * glue:CreateJob
        * iam:PassRole
* S3 bucket in destination account

## Get Started

1. Clone this repository.
2. Install the node dependencies by running `npm install`.
3. Create an IAM role in the source account with the permissions described in the prerequisites section.
4. Create an IAM role in the destination account with the permissions described in the prerequisites section. Create a trust relationship with the source account.
5. Enable DynamoDB streams on each of your DynamoDB tables.
6. Run the `init` operation:
    node index.js -o init -r <aws_region> -i <iam_role_arn> --exports_bucket <bucket_name> --glue_bucket <bucket_name> --glue_role <iam_role_arn>

## Remarks

* Take care when running this script as it does not exclude any tables or event source mappings from the various options.