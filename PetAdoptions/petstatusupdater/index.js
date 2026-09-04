'use strict';

/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
*/

// aws-xray-sdk-core 而不是 aws-xray-sdk —— core 是不含 Express/中间件的轻量包，
// 对 Lambda 是正确选择，也是上游 package.json 与测试 mock 的那一个。
//
// ⚠️ 这行埋点**不能删**。上游 2026-08 的 index.js 把它去掉了（改成裸
//    `new DynamoDBClient({})`），但上游自己的 package.json 仍声明 aws-xray-sdk-core、
//    测试里仍 mock captureAWSv3Client —— 那是上游的内部不一致，不是可以照搬的现状。
//    删掉它会让本 Lambda 在 X-Ray 服务图里消失，而图谱平台的 etl_xray 正是靠
//    GetServiceGraph 建边（本 Lambda 目前以 AWS::Lambda / AWS::Lambda::Function
//    两个条目出现在服务图里）。这属于「移植上游反而是回归」的一例。
const AWSXRay = require('aws-xray-sdk-core');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const dynamoClient = AWSXRay.captureAWSv3Client(new DynamoDBClient({}));
const documentClient = DynamoDBDocumentClient.from(dynamoClient);

exports.handler = async function (event) {
    const payload = JSON.parse(event.body);

    const availability = payload.petavailability === undefined ? 'no' : 'yes';

    const response = await documentClient.send(
        new UpdateCommand({
            TableName: process.env.TABLE_NAME,
            Key: {
                pettype: payload.pettype,
                petid: payload.petid,
            },
            UpdateExpression: 'set availability = :r',
            ExpressionAttributeValues: { ':r': availability },
            ReturnValues: 'UPDATED_NEW',
        }),
    );

    // 采纳上游：把 DynamoDB 的返回也记下来。原实现只记入参，
    // 出问题时分不清「更新请求发出去了但没生效」和「压根没发」。
    console.log(
        `Updated petid: ${payload.petid}, pettype: ${payload.pettype}, to availability: ${availability}`,
    );
    if (response && response.Attributes) {
        console.log(`UPDATED_NEW: ${JSON.stringify(response.Attributes)}`);
    }

    return { statusCode: 200, body: 'success' };
};
