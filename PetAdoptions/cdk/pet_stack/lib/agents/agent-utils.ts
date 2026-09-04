/*
 * agent 构造所需的最小工具集。
 *
 * 上游把这两个函数放在 `src/cdk/lib/utils/utilities.ts` 里，那是个大杂烩模块，
 * 还会 `export { WorkshopNagPack }` 并牵进一串本地没有的传递依赖。
 * 6 个 agent 构造实测**只用到下面这两个方法**（逐文件 grep `Utilities.` 得到：
 * runtime/gateway/guardrail/memory/nutrition-kb 用 createSsmParameters，
 * runtime 另用 TagConstruct，autoreload 一个都不用），
 * 所以这里只搬这两个，不整体引入上游的 utils 模块。
 */
import { CfnOutput, Tags } from 'aws-cdk-lib';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export const AgentUtils = {
    /**
     * 在 `prefix` 下批量建 SSM 参数。
     *
     * 注意 key 是**短名**，最终参数名是 `${prefix}/${key}` ——
     * agent 侧用 `PARAMETER_STORE_PREFIX=/petstore/agent` 读同样的短名，两边必须一致。
     *
     * 与本地 `services-eks.ts:1029` 的写法等价（那里是 `new ssm.StringParameter(this, key, ...)`），
     * 差别只在这里把 prefix 拼进 construct id，避免同名短参数在不同 prefix 下 id 冲突。
     */
    createSsmParameters(scope: Construct, prefix: string, parameters: Map<string, string>) {
        for (const [key, value] of parameters.entries()) {
            const fullKey = `${prefix}/${key}`;
            new StringParameter(scope, fullKey, { parameterName: fullKey, stringValue: value });
        }
    },

    /**
     * 给构造及其**全部子构造**递归打标签。
     *
     * 为什么不直接用 `Tags.of(scope).add(...)`：CDK 的 Tags aspect 只对支持标签的
     * L2 资源自动传播，而这些 agent 构造里有 `CfnRuntime` / `CfnGateway` 等 L1 资源，
     * 递归显式打一遍才能保证 `app:*` 标签落到每个资源上（成本分摊与资源归属都靠它）。
     */
    TagConstruct(object: Construct, tags: { [key: string]: string }) {
        for (const [key, value] of Object.entries(tags)) {
            Tags.of(object).add(key, value);
        }
        for (const child of object.node.children) {
            AgentUtils.TagConstruct(child, tags);
        }
    },

    /** 批量建 CfnOutput，签名与上游 `createOutputs` 一致。 */
    createOutputs(scope: Construct, parameters: Map<string, string>, descriptions?: Map<string, string>) {
        for (const [key, value] of parameters.entries()) {
            new CfnOutput(scope, key, {
                value: value,
                description: descriptions?.get(key) || `Output for ${key}`,
            });
        }
    },
};
