// Worker pool for fusion-model training.
// 融合模型训练的 Worker 线程池。
//
// Keeps a small fixed-size pool of training workers (one per research horizon,
// at most) and a FIFO queue. Jobs that arrive while every worker is busy wait
// their turn instead of spawning unbounded threads. Because training runs in
// the workers, the main HTTP event loop stays free the entire time — a research
// refresh that used to freeze the site for ~10-90s now leaves GET / responsive.
// 维持一个小的固定大小 Worker 池（每研究周期一个、上限封顶），外加 FIFO 队列。
// 所有 Worker 都在忙时，后到的任务排队等待，而不是无限开线程。训练在 Worker 里进行，
// 主 HTTP 事件循环全程空闲 —— 一次研究刷新过去会让站点冻结约 10–90 秒，现在 GET / 始终有响应。

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const workerPath = fileURLToPath(new URL('./train-worker.mjs', import.meta.url));

// One worker per research horizon is enough; cap at the machine's logical cores
// so we never oversubscribe. Four horizons => at most four training threads.
// 每研究周期一个 Worker 已足够；上限封顶到机器逻辑核数，避免超额订阅。四个周期 => 至多四个训练线程。
const POOL_SIZE = Math.max(1, Math.min(4, os.availableParallelism ? os.availableParallelism() : 4));

const pool = [];
const queue = [];
let nextId = 1;

function createWorker() {
  const worker = new Worker(workerPath);
  worker.busy = false;
  worker.currentJob = null;
  worker.on('message', (msg) => {
    const job = worker.currentJob;
    worker.currentJob = null;
    worker.busy = false;
    if (job) {
      if (msg.error) job.reject(Object.assign(new Error(msg.error.message || 'training worker error'), { stack: msg.error.stack }));
      else job.resolve(msg.result);
    }
    dispatch();
  });
  worker.on('error', (err) => {
    const job = worker.currentJob;
    worker.currentJob = null;
    worker.busy = false;
    if (job) job.reject(err);
    // A crashed worker is dropped; the next request will lazily spawn a replacement.
    // 崩溃的 Worker 被丢弃；下次请求时会惰性补一个。
    const idx = pool.indexOf(worker);
    if (idx !== -1) pool.splice(idx, 1);
    dispatch();
  });
  pool.push(worker);
  return worker;
}

function dispatch() {
  while (queue.length) {
    let worker = pool.find((w) => !w.busy);
    if (!worker && pool.length < POOL_SIZE) worker = createWorker();
    if (!worker) break; // every worker busy; the job stays queued
    const job = queue.shift();
    worker.busy = true;
    worker.currentJob = job;
    worker.postMessage({ id: job.id, candles: job.candles, horizon: job.horizon, options: job.options });
  }
}

// Drop-in async replacement for trainFusionModel for callers that do NOT need the
// predictAt / predictBigAt closures (researchOutlook, trainResearchCandidate).
// Callers that need those closures (walkForwardBackfill) should import
// trainFusionModel directly from ./ml-train.mjs and run it in-process.
// 对不需要 predictAt / predictBigAt 闭包的调用方（researchOutlook、trainResearchCandidate）
// 的、可原位替换 trainFusionModel 的异步版本。需要这些闭包的调用方（walkForwardBackfill）
// 应直接从 ./ml-train.mjs 导入 trainFusionModel 并在主线程运行。
export function trainFusionModelAsync(candles, horizon, options = {}) {
  return new Promise((resolve, reject) => {
    queue.push({ id: nextId++, candles, horizon, options, resolve, reject });
    dispatch();
  });
}
