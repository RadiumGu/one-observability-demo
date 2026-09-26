// Mock AWS SDK modules before requiring the handler
jest.mock('@aws-sdk/lib-dynamodb');
jest.mock('@aws-sdk/client-dynamodb');
jest.mock('aws-xray-sdk-core');

describe('Pet Status Updater Lambda', () => {
    let handler;
    // mockSend 与 UpdateCommand 提到 describe 作用域 —— 下面几个用例需要
    // 让 send 抛出特定异常、以及检查传给 UpdateCommand 的参数。
    let mockSend;
    let UpdateCommandMock;

    beforeAll(() => {
        // Set up mocks
        mockSend = jest.fn().mockResolvedValue({});
        const mockDocumentClient = { send: mockSend };

        require('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient = {
            from: jest.fn(() => mockDocumentClient),
        };
        UpdateCommandMock = jest.fn();
        require('@aws-sdk/lib-dynamodb').UpdateCommand = UpdateCommandMock;
        require('@aws-sdk/client-dynamodb').DynamoDBClient = jest.fn();
        require('aws-xray-sdk-core').captureAWSv3Client = jest.fn((client) => client);

        // Now require the handler
        handler = require('./index').handler;
    });

    beforeEach(() => {
        process.env.TABLE_NAME = 'test-table';
        jest.clearAllMocks();
        mockSend.mockResolvedValue({});
    });

    test('should return success response', async () => {
        const event = {
            body: JSON.stringify({
                pettype: 'dog',
                petid: '123',
                petavailability: 'available',
            }),
        };

        const result = await handler(event);

        expect(result.statusCode).toBe(200);
        expect(result.body).toBe('success');
    });

    test('should handle missing petavailability', async () => {
        const event = {
            body: JSON.stringify({
                pettype: 'cat',
                petid: '456',
            }),
        };

        const result = await handler(event);

        expect(result.statusCode).toBe(200);
        expect(result.body).toBe('success');
    });

    test('should parse JSON payload correctly', () => {
        const testPayload = {
            pettype: 'rabbit',
            petid: '789',
            petavailability: 'yes',
        };

        const parsed = structuredClone(testPayload);
        expect(parsed.pettype).toBe('rabbit');
        expect(parsed.petid).toBe('789');
        expect(parsed.petavailability).toBe('yes');
    });

    // ── 以下守的是 2026-09-15 与 2026-09-26 两次生产事故的根因 ──────────
    //
    // UpdateItem 是 upsert：没有 ConditionExpression 时，对不存在的键
    // 调用它会**创建**一条只含 pettype + petid + availability 的残缺行，
    // 而 search-service 读到那种行会 NPE，导致 /api/search 整个 500、
    // 26 条正常记录一起消失。
    //
    // 判据是「传给 UpdateCommand 的参数里有那个条件」，而不是「返回 200」——
    // 缺了条件时这个接口**照样返回 200**，那正是它两次都没被当场发现的原因。

    test('must send ConditionExpression so an update cannot create a pet', async () => {
        const event = {
            body: JSON.stringify({ pettype: 'dog', petid: '123', petavailability: 'yes' }),
        };

        await handler(event);

        expect(UpdateCommandMock).toHaveBeenCalledTimes(1);
        const args = UpdateCommandMock.mock.calls[0][0];
        expect(args.ConditionExpression).toBe('attribute_exists(petid)');
    });

    test('should return 404 when the pet does not exist, instead of creating it', async () => {
        const err = new Error('The conditional request failed');
        err.name = 'ConditionalCheckFailedException';
        mockSend.mockRejectedValueOnce(err);

        const result = await handler({
            body: JSON.stringify({ pettype: 'dog', petid: 'does-not-exist' }),
        });

        expect(result.statusCode).toBe(404);
        expect(result.body).toBe('pet not found');
    });

    test('should surface unexpected DynamoDB errors instead of swallowing them', async () => {
        const err = new Error('boom');
        err.name = 'ProvisionedThroughputExceededException';
        mockSend.mockRejectedValueOnce(err);

        // 只有条件失败才映射成 404；其它异常必须继续抛出，
        // 否则真正的故障会被伪装成「宠物不存在」。
        await expect(
            handler({ body: JSON.stringify({ pettype: 'dog', petid: '123' }) }),
        ).rejects.toThrow('boom');
    });

    test('should reject a non-JSON body with 400 rather than throwing a 502', async () => {
        const result = await handler({ body: 'not json at all' });

        expect(result.statusCode).toBe(400);
        expect(mockSend).not.toHaveBeenCalled();
    });

    test('should reject an incomplete key with 400 and never call DynamoDB', async () => {
        for (const body of [
            JSON.stringify({ petid: '123' }),
            JSON.stringify({ pettype: 'dog' }),
            JSON.stringify({}),
        ]) {
            jest.clearAllMocks();
            const result = await handler({ body });
            expect(result.statusCode).toBe(400);
            expect(mockSend).not.toHaveBeenCalled();
        }
    });
});
