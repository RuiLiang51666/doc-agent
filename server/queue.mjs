// 进程内按 key 串行的任务队列:同一 PR / Issue 的事件排队依次跑,不同 key 之间照常并行。
// 同一 key 已有「排队、还没开始」的同类任务时,新事件直接并入它、不再多排一个:
// plan / draft 本身幂等;revise 每次运行处理本 PR 上全部待处理意见,后跑的那一次会把新意见一起处理掉。
// 任务一开始就撤掉「排队中」记号,运行期间新来的事件会另排一个,不会漏掉运行开始后才提交的意见。
// 不引依赖,离线可测。

export function createKeyedQueue() {
  const tails = new Map(); // key → 该 key 最后一个任务(已吞掉异常,只用来接续)
  const waiting = new Map(); // `${key}|${kind}` → 排队中、未开始的任务

  /**
   * @param key   串行分组,如 "owner/repo#12"
   * @param kind  任务类型(plan / draft / revise);只有同 key 同类型的排队任务才会合并
   * @param task  () => Promise
   * @returns { merged, done }:merged=true 表示并入了已在排队的任务,done 是那个任务的 Promise
   */
  return function enqueue(key, kind, task) {
    const slot = `${key}|${kind}`;
    if (waiting.has(slot)) return { merged: true, done: waiting.get(slot) };
    const prev = tails.get(key) || Promise.resolve();
    const done = prev.then(() => {
      waiting.delete(slot);
      return task();
    });
    waiting.set(slot, done);
    const tail = done.catch(() => {}); // 前一个失败不挡后一个
    tails.set(key, tail);
    tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key); // 队列空了就清理,不无限增长
    });
    return { merged: false, done };
  };
}
