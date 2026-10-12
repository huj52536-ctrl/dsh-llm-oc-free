// 设置页契约测试：锁定「插件凭什么能出现在 设置 → 模型 里」。
//
// 这里复刻的是 DSH 自己的判定逻辑，不是我们的猜测：
//   · @deepseek-ai/dsh-settings        → plainSchema() / volatileForm() / describe()
//   · @deepseek-ai/dsh-client-ui-settings-models → joinProviderDirectory() / configured
//   · @deepseek-ai/cordis              → resolveConfig()
// 复刻片段在下方以 dsh-settings 的名称标注。任一环断掉，provider 行就会从设置页消失。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import z from '../vendor/schemastery.mjs';
import { isVolatile } from '../vendor/cosmokit.js';
import { Config, unwrapVolatile } from '../src/config.mjs';
import { directoryEntry } from '../src/index.mjs';

// ── 以下两个函数逐行复制自 @deepseek-ai/dsh-settings/lib/index.js ──────────
// redactSecrets 在本模式里是恒等变换（没有 role('secret') 字段），故按其行为内联。

/** dsh-settings: plainSchema() —— 把插件模式拍平成可下发的普通模式。 */
function plainSchema(schema) {
  const result = new z(schema.toJSON());
  const walk = (node) => {
    delete node.meta.volatile;
    for (const child of Object.values(node.dict ?? {})) walk(child);
    if (node.inner) walk(node.inner);
    for (const child of node.list ?? []) walk(child);
  };
  walk(result);
  return result;
}

/** dsh-settings: volatileForm() —— 只保留 live 可编辑字段；全无 volatile 时返回 undefined。 */
function volatileForm(schema) {
  if (schema.meta.volatile) return plainSchema(schema);
  if (schema.type === 'object') {
    const dict = Object.fromEntries(Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
      const field = volatileForm(child);
      return field === undefined ? [] : [[key, field]];
    }));
    return Object.keys(dict).length === 0 ? undefined : z.object(dict);
  }
  return undefined;
}

/** dsh-settings: settings.schema(entry) —— 认领插件的 Config。 */
function schemaOf(pluginModule) {
  const schema = pluginModule.Config;
  return schema !== undefined && 'toJSON' in schema ? schema : undefined;
}

/** dsh-settings: describe() 里为 revision 做的哈希，必须可序列化。 */
function revisionHash(schema, config) {
  return JSON.stringify([schema.toJSON(), config]);
}

const PATCH_CONFIG = { opencodePath: '', dataDir: '', requestTimeoutMs: 300000, modelAllowlist: [] };

test('Config 是真正的 Standard Schema（cordis 的 resolveConfig 依赖它）', () => {
  const standard = Config['~standard'];
  assert.equal(typeof standard, 'object');
  assert.equal(standard.version, 1);
  assert.equal(typeof standard.validate, 'function');

  const result = standard.validate(PATCH_CONFIG);
  assert.equal(result.issues, undefined, `校验不该报错：${JSON.stringify(result.issues)}`);
  assert.equal(result.value.requestTimeoutMs, 300000);
  assert.equal(result.value.opencodePath, '');
  assert.deepEqual(result.value.modelAllowlist, []);
});

test('校验失败会给出 issues，而不是抛异常（cordis 会转成 ValidationError）', () => {
  const result = Config['~standard'].validate({ requestTimeoutMs: -1 });
  assert.ok(Array.isArray(result.issues) && result.issues.length > 0);
  assert.match(result.issues[0].message, /requestTimeoutMs/);
});

test('缺省值补齐：只给空对象也能拿到可用配置', () => {
  const { value } = Config['~standard'].validate({});
  assert.equal(value.requestTimeoutMs, 300000);
  assert.equal(value.dataDir, '');
  assert.deepEqual(value.modelAllowlist, []);
});

test('settings 命名空间会被产出（volatileForm 不是 undefined）', () => {
  const schema = schemaOf({ Config });
  assert.notEqual(schema, undefined, 'settings.schema() 认不出这个 Config');

  const form = volatileForm(schema);
  assert.notEqual(form, undefined, '没有任何 volatile 字段 → describe() 会丢掉整个命名空间');
  assert.deepEqual(Object.keys(form.dict ?? {}), ['routes'], '可编辑表单里应只有 volatile 子树');
  assert.doesNotThrow(() => revisionHash(schema, PATCH_CONFIG));
});

test('volatile 字段的解析值必须解引用后才能读（apply 的回归防线）', () => {
  const { value } = Config['~standard'].validate(PATCH_CONFIG);

  // 非 volatile 的兄弟字段是普通值 —— apply() 直接读它们。
  assert.equal(typeof value.requestTimeoutMs, 'number');
  assert.equal(typeof value.opencodePath, 'string');
  assert.ok(Array.isArray(value.modelAllowlist));
  assert.equal(isVolatile(value.opencodePath), false);

  // volatile 字段被换成不透明引用 —— apply() 必须先 unwrapVolatile()。
  assert.equal(isVolatile(value.routes), true);
  assert.deepEqual(unwrapVolatile(value.routes), {});
});

test('routes 覆盖按 provider 存得住，且解引用后是普通对象', () => {
  const { value } = Config['~standard'].validate({
    ...PATCH_CONFIG,
    routes: { 'oc-free': { modelAllowlist: ['opencode/grok-code'], requestTimeoutMs: 1000 } },
  });
  assert.equal(value.issues, undefined);

  const route = unwrapVolatile(value.routes)['oc-free'];
  assert.deepEqual(route.modelAllowlist, ['opencode/grok-code']);
  assert.equal(route.requestTimeoutMs, 1000);
});

test('目录条目的形状能让设置页把这一行渲染出来', () => {
  // dsh-client-ui-settings-models:
  //   configured = namespace !== undefined && (settingsPath.length === 0 || getPath(...) !== undefined)
  //   rows 只渲染 configured 的行；settingsPath 非空又没配过行的会被静默丢掉。
  assert.equal(directoryEntry.provider, 'oc-free');
  assert.equal(directoryEntry.displayName, 'OpenCode 免费模型');
  assert.equal(directoryEntry.settingsNs, 'llm-oc-free');
  assert.deepEqual(directoryEntry.settingsPath, [], 'settingsPath 必须为空，否则依赖用户配置里恰好有该路径');
  assert.equal(directoryEntry.declared, true);

  // dsh-llm: registerConfigurableProviders() 的入参校验（空串会被拒）。
  assert.notEqual(directoryEntry.provider.length, 0);
  assert.notEqual(directoryEntry.displayName.length, 0);
  assert.notEqual(directoryEntry.settingsNs.length, 0);
});

test('设置命名空间与插件的 name 一致（否则 describe() 的 ns 对不上）', () => {
  assert.equal(directoryEntry.settingsNs, 'llm-oc-free');
});

test('volatile 模式遵守 schemastery 的嵌套限制', () => {
  // validateVolatileSchema()：volatile 字段必须落在固定对象路径上，
  // 且不能嵌在另一个 volatile 里 —— 违规以 issues 形式回报（不抛）。
  const bad = z.object({ outer: z.object({ inner: z.dict(z.string()).volatile() }).volatile() });
  const result = bad['~standard'].validate({});
  assert.ok(Array.isArray(result.issues) && result.issues.length > 0);
  assert.match(result.issues[0].message, /enclosing volatile field/);

  // 本插件的形状是「根不 volatile + 一个 volatile 字典」，合法。
  const ok = Config['~standard'].validate({});
  assert.equal(ok.issues, undefined);
});
