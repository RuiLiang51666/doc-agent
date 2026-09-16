// GitHub 只读查询(gh 用 GH_TOKEN 鉴权;网络瞬时错误走 shRead 的重试)。
// 路径由调用方拼好(形如 repos/<owner>/<repo>/pulls/<n>),放进单引号,避免 shell 把 ? 当通配。
import { shRead } from "./sh.mjs";

/** 单个对象。 */
export const ghGet = (path) => JSON.parse(shRead(`gh api '${path}'`));

/** 分页列表:--paginate --slurp 把每页收成「页的数组」,再拍平成一个数组。 */
export const ghList = (path) => JSON.parse(shRead(`gh api --paginate --slurp '${path}'`)).flat();
