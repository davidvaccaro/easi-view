import { digest } from './auth.mjs';

/** Atomic fail-closed quotas shared across every Lambda execution environment. */
export async function createDynamoQuota({ tableName, region = 'us-east-1', client, Command, now = Date.now } = {}) {
    if (typeof tableName !== 'string' || !/^[A-Za-z0-9_.-]{3,255}$/.test(tableName)) throw new Error('A quota table is required.');
    if (!client || !Command) {
        const sdk = await import('@aws-sdk/client-dynamodb');
        client ??= new sdk.DynamoDBClient({ region, maxAttempts: 2 }); Command ??= sdk.UpdateItemCommand;
    }
    return { async consume(key, limit, seconds) {
        const slot = Math.floor(now() / (seconds * 1000));
        try {
            await client.send(new Command({ TableName: tableName, Key: { bucket: { S: `${digest(key).slice(0, 32)}:${slot}` } },
                UpdateExpression: 'SET #expiry = :expiry ADD #count :one',
                ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
                ExpressionAttributeNames: { '#count': 'count', '#expiry': 'expires' },
                ExpressionAttributeValues: { ':one': { N: '1' }, ':limit': { N: String(limit) }, ':expiry': { N: String((slot + 2) * seconds) } } }));
            return true;
        } catch (error) { if (error?.name === 'ConditionalCheckFailedException') return false; throw new Error('The usage limiter is unavailable.'); }
    } };
}
