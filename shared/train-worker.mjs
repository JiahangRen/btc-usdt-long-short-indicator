// Training worker: runs trainFusionModel off the main thread.
// 训练 Worker：在主线程之外跑 trainFusionModel。
//
// The main server posts { id, candles, horizon, options }; this worker trains
// and posts back the (function-stripped) fusion result. Training is pure CPU
// and never touches the database or the network, so the worker is self-contained.
// 主服务发出 { id, candles, horizon, options }；Worker 训练后回传（已剔除函数的）
// 融合结果。训练是纯 CPU，不碰数据库也不碰网络，因此 Worker 自包含。

import { parentPort } from 'node:worker_threads';
import { trainFusionModel } from './ml-train.mjs';

parentPort.on('message', async ({ id, candles, horizon, options }) => {
  try {
    const result = await trainFusionModel(candles, horizon, options);
    // Functions cannot cross the structured-clone boundary. The only consumers of
    // predictAt / predictBigAt are the (main-thread) walk-forward replay, which calls
    // trainFusionModel in-process and keeps the full object, so dropping them here is safe.
    // 函数无法跨 structured-clone 边界。predictAt / predictBigAt 的唯一消费方是
    // （主线程的）回放结算，它就地调用 trainFusionModel、保留完整对象，因此这里丢弃安全。
    if (result) { delete result.predictAt; delete result.predictBigAt; }
    parentPort.postMessage({ id, result: result || null });
  } catch (error) {
    parentPort.postMessage({ id, error: { message: error && error.message, stack: error && error.stack } });
  }
});
