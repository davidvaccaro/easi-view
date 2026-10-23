import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const template = JSON.parse(await readFile(new URL('../infrastructure/ai-demo/template.json', import.meta.url), 'utf8'));
test('AI demo infrastructure is isolated, encrypted and private with no domain mutation or secret outputs', () => {
    assert.equal(template.Resources.ViewerBucket.Properties.PublicAccessBlockConfiguration.BlockPublicPolicy, true);
    assert.equal(template.Resources.ViewerBucket.Properties.BucketEncryption.ServerSideEncryptionConfiguration[0].ServerSideEncryptionByDefault.SSEAlgorithm, 'AES256');
    assert.equal(template.Resources.ViewerBucket.DeletionPolicy, 'Retain'); assert.equal(template.Resources.QuotaTable.DeletionPolicy, 'Retain');
    // false selects DynamoDB's always-on AWS-owned encryption, not plaintext storage.
    assert.equal(template.Resources.QuotaTable.Properties.SSESpecification.SSEEnabled, false);
    assert.equal(Object.values(template.Resources).some(resource => /Route53|Certificate|DomainName/.test(resource.Type)), false);
    assert.equal(Object.values(template.Outputs).some(output => JSON.stringify(output.Value).includes('resolve:secretsmanager')), false);
    for (const resource of Object.values(template.Resources)) assert.ok(resource.Metadata['com.aws.cloudformation.Context']);
});
test('AI demo grants only the selected provider capability and own quota table, with bounded runtime and concurrency', () => {
    const gateway = template.Resources.Gateway.Properties;
    assert.equal(gateway.Timeout, 65); assert.equal(gateway.ReservedConcurrentExecutions, 2); assert.equal(gateway.MemorySize, 256);
    assert.deepEqual(gateway.Environment.Variables.AI_MODEL_ID['Fn::If'], ['UseBedrock', 'amazon.nova-micro-v1:0', { Ref: 'AiModelId' }]);
    const policies = template.Resources.GatewayRole.Properties.Policies, statements = policies[0].PolicyDocument.Statement;
    assert.deepEqual(statements[0].Action, ['dynamodb:UpdateItem']);
    assert.equal(statements.some(statement => statement.Resource === '*'), false);
    const bedrock = policies[1]['Fn::If'], openai = policies[2]['Fn::If'];
    assert.equal(bedrock[0], 'UseBedrock'); assert.deepEqual(bedrock[1].PolicyDocument.Statement[0].Action, ['bedrock:InvokeModelWithResponseStream']);
    assert.match(bedrock[1].PolicyDocument.Statement[0].Resource['Fn::Sub'], /foundation-model\/amazon\.nova-micro-v1:0$/);
    assert.equal(openai[0], 'UseOpenAi'); assert.deepEqual(openai[1].PolicyDocument.Statement[0].Action, ['secretsmanager:GetSecretValue']);
    assert.deepEqual(openai[1].PolicyDocument.Statement[0].Resource, { Ref: 'OpenAiApiKeySecretArn' });
    assert.equal(template.Parameters.AiProvider.Default, 'bedrock');
    assert.ok(template.Rules.OpenAiRequiresSecret);
    assert.equal(Object.hasOwn(gateway.Environment.Variables, 'OPENAI_API_KEY'), false);
    assert.equal(gateway.Environment.Variables.OPENAI_API_KEY_SECRET_ARN['Fn::If'][0], 'UseOpenAi');
    assert.equal(template.Parameters.DailyInvocationLimit.Default, 200);
});
test('AI demo routes bypass cache, pass sessions, enforce HTTPS and use distinct server-side origin authentication', () => {
    const distribution = template.Resources.Distribution.Properties.DistributionConfig, api = distribution.CacheBehaviors[0];
    assert.equal(api.PathPattern, '/api/ai/*'); assert.equal(api.ViewerProtocolPolicy, 'https-only'); assert.equal(api.CachePolicyId.Ref, 'NoCache');
    for (const key of ['MinTTL', 'DefaultTTL', 'MaxTTL']) assert.equal(template.Resources.NoCache.Properties.CachePolicyConfig[key], 0);
    assert.equal(template.Resources.ApiOriginRequest.Properties.OriginRequestPolicyConfig.CookiesConfig.CookieBehavior, 'all');
    assert.ok(template.Resources.ApiOriginRequest.Properties.OriginRequestPolicyConfig.HeadersConfig.Headers.includes('X-Easi-Ai-Model'));
    assert.equal(template.Resources.GatewayUrl.Properties.InvokeMode, 'RESPONSE_STREAM');
    assert.equal(distribution.Origins[1].OriginCustomHeaders[0].HeaderName, 'x-easi-origin-auth');
    assert.notDeepEqual(template.Resources.Gateway.Properties.Environment.Variables.AI_DEMO_PASSCODE, template.Resources.Gateway.Properties.Environment.Variables.AI_ORIGIN_SECRET);
});
test('AI CloudFront function overwrites spoofed origin and client IP using actual edge context', () => {
    const context = vm.createContext({}); vm.runInContext(template.Resources.PublicOrigin.Properties.FunctionCode, context);
    const request = { headers: { host: { value: 'demo.cloudfront.net' }, 'x-easi-public-origin': { value: 'https://attacker.invalid' }, 'x-easi-viewer-ip': { value: 'attacker' } } };
    context.handler({ request, viewer: { ip: '192.0.2.20' } });
    assert.equal(request.headers['x-easi-public-origin'].value, 'https://demo.cloudfront.net'); assert.equal(request.headers['x-easi-viewer-ip'].value, '192.0.2.20');
});
