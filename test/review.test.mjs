// 批量返工纯函数的离线单测:挑待处理意见(按线程分组、识别 doc-agent 已答复)/ 组装返工 prompt。零网络。
// 跑:node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { pendingThreads, reviseUser, isAgentReply, isFailureReply, REPLY_MARK, FAIL_MARK } from "../scripts/review.mjs";

const at = (id) => `2026-09-15T10:00:${String(id).padStart(2, "0")}Z`;
const human = (id, extra = {}) => ({
  id,
  user: { login: "rui", type: "User" },
  path: "docs/zh/cache.md",
  line: 3,
  created_at: at(id),
  body: `意见 ${id}`,
  ...extra,
});
const bot = (id, body, extra = {}) => ({
  id,
  user: { login: "github-actions[bot]", type: "Bot" },
  path: "docs/zh/cache.md",
  created_at: at(id),
  body,
  ...extra,
});

const COMMENTS = [
  human(1, { body: "get 补上返回值", pull_request_review_id: 500 }),
  human(2, { body: "size 改成条目数", line: 9, pull_request_review_id: 500 }),
  human(3, { body: "旧意见" }),
  bot(4, "Done in abc1234 ✅", { in_reply_to_id: 3 }), // 加标记之前的历史回复
  human(5, { body: "旧意见 2" }),
  bot(6, "⚠️ 按这条评论返工失败:LLM 429", { in_reply_to_id: 5 }),
  human(7, { body: "改一下示例" }),
  human(8, { body: `Done in 1234567 ✅\n\n${REPLY_MARK}`, in_reply_to_id: 7 }), // 用 PAT 跑时,回复人不是 Bot
  human(9, { body: "还是不对,补一个例子", in_reply_to_id: 7 }), // 答复后追问
  human(10, { body: "/skip" }),
  bot(11, "某个第三方 bot 的建议"),
  human(12, { body: "已解决线程里的意见" }),
  human(13, { body: "第三方 bot 回过但 doc-agent 没处理" }),
  bot(14, "LGTM(第三方 bot)", { in_reply_to_id: 13 }),
];

test("pendingThreads:同一次 review 的多条意见都待处理;已答复、/ 指令、Bot 评论、已解决线程跳过;追问重新待处理", () => {
  const threads = pendingThreads(COMMENTS, new Set([12]));
  assert.deepEqual(
    threads.map((t) => [t.rootId, t.items.map((i) => i.id)]),
    [
      [1, [1]],
      [2, [2]],
      [5, [5]], // 下面只有一条失败回帖(历史写法)→ 意见没落实,仍待处理
      [7, [9]],
      [13, [13]],
    ]
  );
  assert.equal(threads[1].items[0].line, 9);
  assert.equal(threads[2].path, "docs/zh/cache.md");
  assert.deepEqual(pendingThreads([]), []);
});

test("pendingThreads:成功回复 → 已答复;失败回帖 → 仍待处理;失败后人再追问 → 待处理(两条都算)", () => {
  const ok = [human(20, { body: "把示例补全" }), human(21, { body: `Done in abc1234 ✅\n\n${REPLY_MARK}`, in_reply_to_id: 20 })];
  assert.deepEqual(pendingThreads(ok), []); // ① 成功回复 = 已答复,不再重跑

  const failed = [
    human(30, { body: "整节搬到 1.3 之前" }),
    bot(31, `⚠️ 按这条评论返工失败(原因类别:**模型调用超时**):…\n\n${FAIL_MARK}\n${REPLY_MARK}`, { in_reply_to_id: 30 }),
  ];
  assert.deepEqual(
    pendingThreads(failed).map((t) => [t.rootId, t.items.map((i) => i.id)]),
    [[30, [30]]] // ② 失败回帖不算答复:下一次 review 会重新处理这条意见
  );

  const asked = [...failed, human(32, { body: "另外再补个例子", in_reply_to_id: 30 })];
  assert.deepEqual(
    pendingThreads(asked).map((t) => [t.rootId, t.items.map((i) => i.id)]),
    [[30, [30, 32]]] // ③ 失败后人再追问:原意见与追问都待处理
  );

  // 成功回复之后又失败一次(第二轮追问没做成):追问那条仍待处理,更早的已答复意见不重复处理
  const mixed = [
    human(40, { body: "第一轮意见" }),
    human(41, { body: `Done in abc1234 ✅\n\n${REPLY_MARK}`, in_reply_to_id: 40 }),
    human(42, { body: "第二轮追问", in_reply_to_id: 40 }),
    human(43, { body: `⚠️ 按这条评论返工失败…\n\n${FAIL_MARK}\n${REPLY_MARK}`, in_reply_to_id: 40 }),
  ];
  assert.deepEqual(
    pendingThreads(mixed).map((t) => [t.rootId, t.items.map((i) => i.id)]),
    [[40, [42]]]
  );
});

test("isFailureReply:带失败标记 / Bot 的历史失败回帖算失败;成功回复与人手打的同样格式不算", () => {
  assert.ok(isFailureReply({ user: { type: "User" }, body: `x\n${FAIL_MARK}\n${REPLY_MARK}` }));
  // v1.2.2 已经发出去的失败回帖只带 REPLY_MARK,靠固定措辞 + Bot 身份认出来(#5655 的 4 条就是这种)
  assert.ok(isFailureReply({ user: { type: "Bot" }, body: `⚠️ 按这条评论返工失败(原因类别:**模型接口报错**)\n\n${REPLY_MARK}` }));
  assert.ok(!isFailureReply({ user: { type: "Bot" }, body: `Done in abc1234 ✅\n\n${REPLY_MARK}` }));
  assert.ok(!isFailureReply({ user: { type: "User" }, body: "⚠️ 按这条评论返工失败(我手打的)" }));
  assert.ok(isAgentReply({ user: { type: "User" }, body: `x\n${FAIL_MARK}\n${REPLY_MARK}` })); // 失败回帖仍是 doc-agent 的回复,不会被当成新意见
});

test("reviseUser / isAgentReply:列出全部意见(编号 + 位置 + 原话),同一文件只附一次全文;只认标记或 Bot 的历史回复", () => {
  const user = reviseUser(pendingThreads(COMMENTS).slice(0, 2), (p) => `<${p} 全文>`);
  assert.match(user, /reviewer 留了 2 条待处理意见/);
  assert.match(user, /\[1\] docs\/zh\/cache\.md:3\n"get 补上返回值"/);
  assert.match(user, /\[2\] docs\/zh\/cache\.md:9\n"size 改成条目数"/);
  assert.equal(user.split("当前文件 docs/zh/cache.md:").length - 1, 1);
  assert.match(user, /范围大的改动请拆成多条小 edits/); // 单次输出越长越容易超时 / 被截断
  assert.ok(isAgentReply({ user: { type: "User" }, body: `x\n${REPLY_MARK}` }));
  assert.ok(isAgentReply({ user: { type: "Bot" }, body: "Done in abc1234 ✅" }));
  assert.ok(!isAgentReply({ user: { type: "User" }, body: "Done in abc1234 ✅" })); // 人手打的同样格式不算
});
