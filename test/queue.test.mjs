// server 进程内队列的离线单测:同一 PR / Issue 串行、不同 key 并行、排队中的同类任务合并、失败不挡后续。零网络。
// 跑:node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { createKeyedQueue } from "../server/queue.mjs";

const tick = () => new Promise((r) => setTimeout(r, 5));
const deferred = () => {
  let resolve;
  const p = new Promise((r) => (resolve = r));
  return { p, resolve };
};

test("queue:同一 key 串行,不同 key 并行", async () => {
  const enqueue = createKeyedQueue();
  const log = [];
  const gate = deferred();
  const a = enqueue("o/r#1", "revise", async () => {
    log.push("a start");
    await gate.p;
    log.push("a end");
  });
  const b = enqueue("o/r#1", "draft", async () => log.push("b start"));
  const c = enqueue("o/r#2", "revise", async () => log.push("c start"));
  await tick();
  assert.deepEqual(log, ["a start", "c start"]); // b 等 a;c 不等
  gate.resolve();
  await Promise.all([a.done, b.done, c.done]);
  assert.deepEqual(log, ["a start", "c start", "a end", "b start"]);
});

test("queue:同 key 同类型已在排队(未开始)→ 新事件并入;运行中再来的事件另排一个,不漏", async () => {
  const enqueue = createKeyedQueue();
  let runs = 0;
  const gate = deferred();
  const first = enqueue("o/r#9", "revise", async () => {
    runs++;
    await gate.p;
  });
  await tick(); // first 已开始运行
  const second = enqueue("o/r#9", "revise", async () => runs++);
  const third = enqueue("o/r#9", "revise", async () => runs++);
  assert.equal(first.merged, false);
  assert.equal(second.merged, false);
  assert.equal(third.merged, true);
  assert.equal(third.done, second.done);
  gate.resolve();
  await second.done;
  assert.equal(runs, 2);
});

test("queue:前一个任务失败不挡后一个", async () => {
  const enqueue = createKeyedQueue();
  const bad = enqueue("o/r#3", "plan", async () => {
    throw new Error("boom");
  });
  const good = enqueue("o/r#3", "draft", async () => "ok");
  await assert.rejects(bad.done, /boom/);
  assert.equal(await good.done, "ok");
});
