#!/usr/bin/env node
// Tuning wiring check.
//
// Moving every research threshold into one configuration block buys reviewability but introduces a
// new failure mode: a parameter can be declared and never read. That failure is silent. The value
// sits in the config, the config is visible in the API, and the model keeps using whatever number
// was hard-coded before - which is exactly the state the refactor was meant to end.
//
// This check reads RESEARCH_TUNING_DEFAULTS out of server.mjs and asserts two things:
//   1. every leaf is read somewhere outside the declaration block (no dead parameters);
//   2. every RESEARCH_TUNING.<path> reference resolves to a declared leaf (no typo'd paths, which
//      would otherwise surface as `undefined` at runtime rather than as an error).
//
// It is a heuristic: leaf names are matched as property accesses, so an unrelated `.cap` elsewhere
// can mask a genuinely unread `cap`. It never produces false alarms about missing wiring, only
// occasional false reassurance - which is the right direction for a guard.
//
// 调参接线自检。
//
// 把所有研究门槛收进一个配置块换来了可审查性，也带来一种新的失效模式：参数被声明却从未被读取。
// 这种失效是静默的 —— 值躺在配置里、API 里也看得见，而模型仍在用重构前硬编码的那个数字，正是
// 这次重构要终结的状态。
//
// 本脚本从 server.mjs 里读出 RESEARCH_TUNING_DEFAULTS，断言两件事：
//   1. 每个叶子都在声明块之外被读取过（没有死参数）；
//   2. 每个 RESEARCH_TUNING.<path> 引用都能解析到已声明的叶子（没有拼错的路径 —— 否则运行时
//      只会得到 undefined 而不报错）。
//
// 这是启发式检查：叶子名按属性访问匹配，因此别处一个无关的 `.cap` 可能掩盖某个确实没被读取的
// `cap`。它不会误报「接线缺失」，只可能偶尔漏报 —— 对一道守卫来说这是正确的方向。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// 声明已迁到 shared/research-tuning.mjs（阶段 11 抽出，主服务与训练 Worker 共用）。
// 使用处分布在 server.mjs 与 shared/ml-train.mjs，二者都要纳入接线扫描。
const declSource = readFileSync(join(root, 'shared/research-tuning.mjs'), 'utf8');
const usageSource = [
  readFileSync(join(root, 'server.mjs'), 'utf8'),
  readFileSync(join(root, 'shared/ml-train.mjs'), 'utf8'),
].join('\n');

const marker = 'const RESEARCH_TUNING_DEFAULTS = ';
const start = declSource.indexOf(marker);
if (start < 0) {
  console.error('× 找不到 RESEARCH_TUNING_DEFAULTS 声明');
  process.exit(1);
}
const open = declSource.indexOf('{', start);
let depth = 0, end = -1;
for (let index = open; index < declSource.length; index++) {
  const character = declSource[index];
  if (character === '{') depth += 1;
  else if (character === '}') {
    depth -= 1;
    if (depth === 0) { end = index + 1; break; }
  }
}
if (end < 0) {
  console.error('× RESEARCH_TUNING_DEFAULTS 块未闭合');
  process.exit(1);
}

let defaults;
try {
  defaults = new Function(`return (${declSource.slice(open, end)});`)();
} catch (error) {
  console.error(`× 无法求值配置块：${error.message}`);
  process.exit(1);
}

// 声明已迁到 shared/research-tuning.mjs，使用处（server.mjs + shared/ml-train.mjs）即 usageSource。
// A parameter that is only mentioned by its own default is not wired to anything.
const outside = usageSource;

const collectLeaves = (value, prefix = '', out = []) => {
  for (const [key, item] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (item && typeof item === 'object' && !Array.isArray(item)) collectLeaves(item, path, out);
    else out.push({ path, key, value: item });
  }
  return out;
};
const leaves = collectLeaves(defaults);
const declared = new Set(leaves.map(leaf => leaf.path));

// A configuration subtree may legitimately be read through a variable key - the per-horizon gate
// table is looked up as `overrides?.[key]`, so no literal `.1d` ever appears in the source and the
// leaf test below would flag a genuinely wired parameter as dead. Recognise that pattern
// explicitly instead of weakening the check for everything: a subtree only earns the exemption if
// it is both bound from RESEARCH_TUNING *and* then indexed with a computed key.
// 配置子树可以正当地通过变量键读取 —— 按周期的门槛表就是 `overrides?.[key]`，源码里根本不会出现
// 字面量 `.1d`，于是下面的叶子判定会把一个确实已接线的参数误判成死参数。这里显式识别该模式，
// 而不是为所有参数放宽带宽：只有既从 RESEARCH_TUNING 绑定、又随后用计算键取下标，才获得豁免。
const dynamicRoots = new Set();
for (const match of outside.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*RESEARCH_TUNING((?:\.[A-Za-z_$][\w$]*)+)\s*[,;]/g)) {
  const [, name, path] = match;
  if (new RegExp(`${name}\\s*(?:\\?\\.)?\\[`).test(outside)) dynamicRoots.add(path.slice(1));
}
const isDynamic = path => [...dynamicRoots].some(root => path.startsWith(`${root}.`));

const unread = leaves.filter(leaf => !isDynamic(leaf.path) && !new RegExp(`\\.\\s*${leaf.key}\\b`).test(outside));
const dynamicLeaves = leaves.filter(leaf => isDynamic(leaf.path));

const referenced = new Set();
for (const match of outside.matchAll(/(?<![A-Za-z_$])RESEARCH_TUNING((?:\.[A-Za-z_$][\w$]*)+)/g)) {
  referenced.add(match[1].slice(1));
}
const unknown = [...referenced].filter(path => !declared.has(path) && ![...declared].some(candidate => candidate.startsWith(`${path}.`)));

const fingerprint = (() => {
  const flat = Object.fromEntries(leaves.map(leaf => [leaf.path, leaf.value]));
  const text = Object.keys(flat).sort().map(key => `${key}=${JSON.stringify(flat[key])}`).join('|');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(16).padStart(8, '0');
})();

let failed = false;
if (unread.length) {
  failed = true;
  console.error(`× ${unread.length} 个已声明但从未被读取的研究参数：`);
  for (const leaf of unread) console.error(`    ${leaf.path} = ${JSON.stringify(leaf.value)}`);
  console.error('  取值必须在 RESEARCH_TUNING_DEFAULTS 之外至少被读取一次，否则它只是一个摆设。');
}
if (unknown.length) {
  failed = true;
  console.error(`× ${unknown.length} 个引用解析不到已声明路径：`);
  for (const path of unknown) console.error(`    RESEARCH_TUNING.${path}`);
  console.error('  这类拼写错误在运行时不报错，只会静默地得到 undefined。');
}

if (failed) process.exit(1);
const dynamicNote = dynamicLeaves.length ? `，另有 ${dynamicLeaves.length} 个叶子经计算键读取（${[...dynamicRoots].join('、')}，键由运行时决定）` : '';
console.log(`✓ 调参接线完整：${leaves.length} 个叶子全部被读取，${referenced.size} 处引用全部可解析（fingerprint ${fingerprint}）${dynamicNote}`);
