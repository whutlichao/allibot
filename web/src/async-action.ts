/**
 * 组件与宿主之间的异步动作类型。
 *
 * 动作只在 Promise 兑现后才算成功（加入频道、保存系统提示、软删除 Agent），
 * 组件用它的兑现 / 拒绝决定按钮状态；写成调用签名接口而不是内联箭头函数，
 * 是为了让「这是异步动作」这件事在 props 上有名字。
 */

/** 无参数的异步动作。 */
export interface AsyncAction {
  (): Promise<void>;
}

/** 一个参数的异步动作。 */
export interface AsyncAction1<A> {
  (arg: A): Promise<void>;
}

/** 两个参数的异步动作。 */
export interface AsyncAction2<A, B> {
  (first: A, second: B): Promise<void>;
}
