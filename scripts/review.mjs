// 批量返工的纯函数:从 PR 的全部行内 review 评论里挑出「还没被 doc-agent 答复过」的意见,按线程分组;组装返工 prompt。
// 离线可测,不碰 GitHub。

// doc-agent 在线程里的每条回复都带这个隐藏标记,下次运行据此判断「已答复」
export const REPLY_MARK = "<!-- doc-agent:reply -->";
// 加标记之前的历史回复(Done in <sha> ✅ / ⚠️ 按这条评论返工失败),只认 Bot 发的
const LEGACY_REPLY = /^\s*(Done in [0-9a-f]{7,40} ✅|⚠️ 按这条评论返工失败)/;

const bodyOf = (c) => String((c && c.body) || "");

/** 是否为 doc-agent 的回复:带标记(用 PAT 跑时发帖人不是 Bot,也认得出),或 Bot 发的历史回复。 */
export const isAgentReply = (c) =>
  bodyOf(c).includes(REPLY_MARK) || (c?.user?.type === "Bot" && LEGACY_REPLY.test(bodyOf(c)));

// 算作意见:人发的(非 Bot)、非空、不以 / 开头(那是指令)
const isInstruction = (c) => {
  const b = bodyOf(c).trim();
  return c?.user?.type !== "Bot" && !isAgentReply(c) && b !== "" && !b.startsWith("/");
};

/**
 * 待处理的意见,按线程分组。线程 = 根评论 + 它的全部回复;线程里最后一条 doc-agent 回复之后的人工意见才算待处理
 * (答复过又追问的,追问那条重新变成待处理)。已解决的线程整条跳过。
 * @param comments GET /repos/{repo}/pulls/{n}/comments 的结果
 * @param resolved 已解决线程里的评论 id 集合
 * @returns [{ rootId, path, items: [{ id, line, body }] }],按线程首条评论的时间排序
 */
export function pendingThreads(comments, resolved = new Set()) {
  const list = comments || [];
  const byId = new Map(list.map((c) => [c.id, c]));
  const rootOf = (c) => {
    let cur = c;
    for (let hops = 0; cur.in_reply_to_id && byId.has(cur.in_reply_to_id) && hops < 1000; hops++)
      cur = byId.get(cur.in_reply_to_id);
    return cur.in_reply_to_id ?? cur.id; // 根评论已删除时,用它的 id 归组
  };
  const time = (c) => Date.parse(c.created_at) || 0;
  const threads = new Map();
  for (const c of [...list].sort((a, b) => time(a) - time(b) || a.id - b.id)) {
    const root = rootOf(c);
    if (!threads.has(root)) threads.set(root, []);
    threads.get(root).push(c);
  }
  const out = [];
  for (const [rootId, cs] of threads) {
    if (cs.some((c) => resolved.has(c.id))) continue;
    const items = cs.slice(cs.findLastIndex(isAgentReply) + 1).filter(isInstruction);
    if (!items.length) continue;
    out.push({
      rootId,
      path: cs[0].path,
      items: items.map((c) => ({ id: c.id, line: c.line ?? c.original_line ?? null, body: bodyOf(c).trim() })),
    });
  }
  return out;
}

/** 返工 prompt:先列全部待处理意见(编号 + 位置 + 原话),再附涉及文件的当前全文(每个文件只附一次)。 */
export function reviseUser(threads, read) {
  let k = 0;
  const notes = threads
    .flatMap((t) => t.items.map((it) => `[${++k}] ${t.path}${it.line ? `:${it.line}` : ""}\n"${it.body}"`))
    .join("\n\n");
  const files = [...new Set(threads.map((t) => t.path))].map((p) => `当前文件 ${p}:\n${read(p)}`).join("\n\n");
  return `这是一次返工。reviewer 留了 ${k} 条待处理意见:

${notes}

逐条处理这些意见所指的地方,一次给出全部编辑;其余每一行逐字节不变。

${files}`;
}
