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
    // 非 JSON 的 body 以前会让 JSON.parse 抛出 → 未捕获 → 502。
    // 502 会被当成「服务坏了」去查 Lambda，而真因是调用方发错了东西。
    let payload;
    try {
        payload = JSON.parse(event.body);
    } catch {
        console.warn('Rejected non-JSON body');
        return { statusCode: 400, body: 'invalid json body' };
    }

    // 主键两个都必须给。少一个以前是 DynamoDB ValidationException → 502，
    // 同样把调用方的错误伪装成服务故障。
    if (!payload || !payload.pettype || !payload.petid) {
        console.warn(
            `Rejected update with incomplete key: pettype=${payload && payload.pettype}, petid=${payload && payload.petid}`,
        );
        return { statusCode: 400, body: 'pettype and petid are required' };
    }

    const availability = payload.petavailability === undefined ? 'no' : 'yes';

    let response;
    try {
        response = await documentClient.send(
            new UpdateCommand({
                TableName: process.env.TABLE_NAME,
                Key: {
                    pettype: payload.pettype,
                    petid: payload.petid,
                },
                UpdateExpression: 'set availability = :r',
                ExpressionAttributeValues: { ':r': availability },
                // ⚠️ 这个条件是本文件里最重要的一行，删掉会重现一次生产事故。
                //
                // DynamoDB 的 UpdateItem 是 **upsert**：键不存在时它不会报错，
                // 而是**创建**一条只含 pettype + petid + availability 的新行。
                // 也就是说这个「状态更新」接口在没有这个条件时可以凭
                // 三个属性凭空造出一只宠物 —— 而 search-service 的 mapToPet
                // 会在缺少 petcolor/pettype/price/image 时 NPE，于是
                // /api/search 整个 500，**26 条正常记录一起消失**，
                // 首页变成 HTTP 200 的空白错误页。
                //
                // 2026-09-15 与 2026-09-26 各发生过一次，形态完全相同。
                // search-service 侧已加容错（跳过残缺行），但那是止血；
                // 这一行才是不让脏数据进库的根。
                //
                // attribute_exists(petid) 在条目不存在时整体为假 —— 这是
                // 「仅在记录已存在时更新」的标准写法。
                ConditionExpression: 'attribute_exists(petid)',
                ReturnValues: 'UPDATED_NEW',
            }),
        );
    } catch (err) {
        if (err && err.name === 'ConditionalCheckFailedException') {
            // 不是服务故障，是调用方要更新一只不存在的宠物。
            console.warn(
                `Rejected status update for unknown pet: pettype=${payload.pettype}, petid=${payload.petid}`,
            );
            return { statusCode: 404, body: 'pet not found' };
        }
        throw err;
    }

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
