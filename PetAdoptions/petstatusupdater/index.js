'use strict';

const AWSXRay = require('aws-xray-sdk');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const dynamoClient = AWSXRay.captureAWSv3Client(new DynamoDBClient());
const documentClient = DynamoDBDocumentClient.from(dynamoClient);

exports.handler = async function (event) {
    const payload = JSON.parse(event.body);

    const availability = payload.petavailability === undefined ? 'no' : 'yes';

    await documentClient.send(new UpdateCommand({
        TableName: process.env.TABLE_NAME,
        Key: {
            pettype: payload.pettype,
            petid: payload.petid,
        },
        UpdateExpression: 'set availability = :r',
        ExpressionAttributeValues: { ':r': availability },
        ReturnValues: 'UPDATED_NEW',
    }));

    console.log(`Updated petid: ${payload.petid}, pettype: ${payload.pettype}, to availability: ${availability}`);
    return { statusCode: 200, body: 'success' };
};
