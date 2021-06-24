const fs = require('fs');

const AWS = require('aws-sdk');
const { program } = require('commander');
const winston = require('winston');

// Constant for detecting if script is running as a Lambda function 
const IS_LAMBDA = !!process.env.LAMBDA_TASK_ROOT;

// Set up program options
program
    .requiredOption('-o, --operation <operation>', 'Operation to perform (init/enable/disable)', process.env.operation)
    .requiredOption('-r, --region <region>', 'AWS region)', process.env.region)
    .requiredOption('-i, --role <iam_role_arn>', 'Destination account IAM role to be assumed)', process.env.iamRole)
    .requiredOption('--exports_bucket <bucket_name>', 'Destination account S3 bucket for DynamoDB exports', process.env.glueBucket)
    .requiredOption('--glue_bucket <bucket_name>', 'Destination account S3 bucket for Glue scripts', process.env.glueBucket)
    .requiredOption('--glue_role <iam_role_arn>', 'Destination account IAM role to be set for Glue jobs', process.env.glueRole)
    .option('-l, --log <log_level>', 'Logging level (error/warn/info)', process.env.log || 'info');
program.parse(process.argv);

const options = program.opts();

// Set up logger
const logger = winston.createLogger({
    level: options.log,
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.combine(
                    winston.format.colorize({
                        all: true
                    }),
                    winston.format.timestamp({
                        format: 'YY-MM-DD HH:MM:SS'
                    }),
                    winston.format.printf(
                        info => ` ${info.timestamp} ${info.level}: ${info.message}`
                    )
                ),
            )
        })
    ],
});

AWS.config.update({ region: options.region });

// Define function to get destination account role STS credentials
const getCrossAccountCredentials = async () => {
    const sts = new AWS.STS();

    return new Promise((resolve, reject) => {
        const timestamp = (new Date()).getTime();
        const params = {
            RoleArn: options.role,
            RoleSessionName: `ddb-utlity-${timestamp}`
        };

        sts.assumeRole(params, (error, data) => {
            if (error) {
                reject(error);
            }
            else {
                resolve({
                    accessKeyId: data.Credentials.AccessKeyId,
                    secretAccessKey: data.Credentials.SecretAccessKey,
                    sessionToken: data.Credentials.SessionToken,
                });
            }
        });
    });
};

// Define operation scripts
const scripts = {};

scripts.init = async () => {
    // Get destination account credentials 
    const destAccountCredentials = await getCrossAccountCredentials();

    const sourceDynamodb = new AWS.DynamoDB();
    const destDynamodb = new AWS.DynamoDB(destAccountCredentials);
    const destS3 = new AWS.S3(destAccountCredentials);
    const destGlue = new AWS.Glue(destAccountCredentials);

    // Get source tables
    const tableNames = await new Promise((resolve, reject) => {
        sourceDynamodb.listTables({}).promise()
        .then((data) => {
            resolve(data.TableNames);
        })
        .catch((error) => {
            logger.error(`Failed to retrieve tables`);
            reject(error);
        });
    });

    // Get table information
    const describeTablePromises = [];

    tableNames.forEach((tableName) => {
        const promise = new Promise((resolve, reject) => {
            sourceDynamodb.describeTable({ TableName: tableName }).promise()
            .then((data) => {
                resolve({
                    name: tableName,
                    config: data.Table
                });
            })
            .catch((error) => {
                logger.error(`Failed to describe table ${tableName}`);
                reject(error);
            });
        });

        describeTablePromises.push(promise);
    });

    const tables = await Promise.all(describeTablePromises);

    // Enable PITR for each table
    const enablePitrPromises = [];

    tables.forEach((table) => {
        const tableName = table.name;

        const promise = new Promise((resolve, reject) => {
            sourceDynamodb.updateContinuousBackups(
                {
                    TableName: tableName,
                    PointInTimeRecoverySpecification: {
                        PointInTimeRecoveryEnabled: true
                    },
                }
            ).promise()
                .then(() => {
                    logger.info(`Enabled PITR for table ${tableName}`);
                    resolve(tableName);
                })
                .catch((error) => {
                    logger.error(`Failed to enable PITR for table ${tableName}`);
                    reject(error);
                });
        });

        enablePitrPromises.push(promise);
    });

    await Promise.all(enablePitrPromises);
    logger.info(`Completed enabling PITR for ${enablePitrPromises.length} tables`);

    // Enable DynamoDB streams for each table
    const updateTablePromises = [];

    tables.forEach((table) => {
        const tableName = table.name;

        const promise = new Promise((resolve, reject) => {
            sourceDynamodb.updateTable(
                {
                    TableName: tableName,
                    StreamSpecification: {
                        StreamEnabled: true,
                        StreamViewType: 'NEW_IMAGE'
                    }
                }
            ).promise()
            .then(() => {
                logger.info(`Enabled DynamoDB stream for table ${tableName}`);
                resolve(tableName);
            })
            .catch((error) => {
                logger.error(`Failed to enable DynamoDB streams for table ${tableName}`);
                reject(error);
            });
        });

        updateTablePromises.push(promise);
    });

    await Promise.all(updateTablePromises);
    logger.info(`Completed enabling DynamoDB streams for ${enablePitrPromises.length} tables`);

    // Get destination tables
    const destTableNames = await new Promise((resolve, reject) => {
        destDynamodb.listTables({}).promise()
        .then((data) => {
            resolve(data.TableNames);
        })
        .catch((error) => {
            logger.error(`Failed to retrieve tables`);
            reject(error);
        });
    }); 

    // Create DynamoDB tables
    const createTablePromises = [];

    tables.forEach((table) => {
        const tableName = table.name;

        // Skip creation of table if it already exists
        if (destTableNames.indexOf(tableName) !== -1) {
            return;
        }

        const promise = new Promise((resolve, reject) => {
            const params = Object.assign({ TableName: tableName }, table.config);

            delete params.CreationDateTime;
            delete params.ItemCount;
            delete params.LastDecreaseDateTime;
            delete params.LatestStreamArn;
            delete params.LatestStreamLabel;
            delete params.NumberOfDecreasesToday;
            delete params.TableArn;
            delete params.TableId;
            delete params.TableSizeBytes;
            delete params.TableStatus;
            delete params.ProvisionedThroughput.LastDecreaseDateTime;
            delete params.ProvisionedThroughput.NumberOfDecreasesToday;

            destDynamodb.createTable(params).promise()
            .then(() => {
                logger.info(`Created table ${tableName}`);
                resolve(tableName);
            })
            .catch((error) => {
                logger.error(`Failed to create DynamoDB table ${tableName}`);
                reject(error);
            });
        });

        createTablePromises.push(promise);
    });

    await Promise.all(createTablePromises);
    logger.info(`Completed creating ${createTablePromises.length} tables`);

    // Create Glue scripts and upload them to S3
    const createGlueScriptPromises = [];

    // Load template
    let scriptTemplate = fs.readFileSync('data/glue-script-template.py', 'utf8');
    scriptTemplate = scriptTemplate.replace(/%%REGION%%/g, options.region);

    tables.forEach((table) => {
        const tableName = table.name;

        const promise = new Promise((resolve, reject) => {
            // Make a copy of the script (the weirdness is to force a copy instead of a reference)
            let script = (' ' + scriptTemplate).slice(1);

            // TO-DO: Update this with the path to the actual table
            script = scriptTemplate.replace(/%%EXPORTS_BUCKET%%/g, `${options.exports_bucket}/exports/${tableName}/`);
 
            // Replace table name
            script = script.replace(/%%TABLE%%/g, tableName);

            // TO-DO: Construct mappings (AttributeDefinitions only contains key attributes)
            const mappings = table.config.AttributeDefinitions.map((attribute) => {
                const { AttributeName: name, AttributeType: type } = attribute;

                // TO-DO: Expand support beyond number, string and boolean types
                const glueType = (() => {
                    switch (type) {
                        case 'N':
                            return 'long';
                        case 'S':
                            return 'string';
                        case 'BOOL':
                            return 'boolean';
                        default:
                            return 'string';
                    }
                })();

                return `("Item.${name}.${type}", "string", "${name}", "${glueType}")`
            });

            // Replace mappings
            script = script.replace(/%%MAPPINGS%%/g, mappings.join(','));

            // Upload script to S3
            destS3.putObject({
                Body: script, 
                Bucket: options.glue_bucket, 
                Key: `glue-script-${tableName}.py`
            }).promise()
            .then(() => {
                logger.info(`Uploaded Glue script for table ${tableName}`);
                resolve(tableName);
            })
            .catch((error) => {
                logger.error(`Failed to upload Glue script for table ${tableName}`);
                reject(error);
            });
        });
    });

    await Promise.all(createGlueScriptPromises);
    logger.info(`Completed creating ${createTablePromises.length} Glue script files`);

    // Create Glue jobs
    const createJobPromises = [];

    tables.forEach((table) => {
        const tableName = table.name;

        const promise = new Promise((resolve, reject) => {
            destGlue.createJob({
                Name: `ddb-job-${tableName}`,
                Role: options.glue_role,
                Command: {
                    Name: 'glueetl',
                    PythonVersion: '3',
                    ScriptLocation: `s3://${options.glue_bucket}/glue-script-${tableName}.py`
                },
                Description: `Glue job for ${tableName}`,
                MaxRetries: 0,
                NumberOfWorkers: 10,
                WorkerType: 'G.1X'
            }).promise()
            .then(() => {
                logger.info(`Created Glue job for table ${tableName}`);
                resolve(tableName);
            })
            .catch((error) => {
                logger.error(`Failed to Glue job for table ${tableName}`);
                reject(error);
            });
        });

        createJobPromises.push(promise);
    });

    await Promise.all(createJobPromises);
    logger.info(`Completed creating ${createJobPromises.length} Glue jobs`);

};

// Define run function
const run = async (operation, excludedStreams) => {
    // Run appropriate script
    const script = scripts[operation];

    if (typeof script === 'function') {
        script(excludedStreams);
    }
    else {
        logger.error(`The specified operation (${operation}) is not valid.`);
    }
};

if (IS_LAMBDA) {
    module.exports.handler = async (event, context) => {
        return await run(event.operation, event.excludedStreams);
    };
}
else {
    run(options.operation, options.excludedStreams);
}