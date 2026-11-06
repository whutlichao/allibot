/**
 * 工作台读数的作废票据。
 *
 * 读数不是同一时刻的：SSE 帧触发的刷新、创建动作带回的读数、页面首次加载
 * 都可能同时在飞，先起飞的那一次可能后落地。票据把「谁的最新」变成一次单调
 * 递增的编号：每次 `begin()` 都作废此前所有在飞的读数，只有最后一张票据算最
 * 新。于是倒数第二个落地的旧读数会被判为过期、在被采用之前就丢弃，不会把刚
 * 建好的频道 / Agent 从导航里抹掉。
 */
export interface ReadingTickets {
  /** 开一次新的读数：作废此前所有在飞的票据，返回这一次的票据。 */
  begin: () => number;
  /** 这张票据是否仍是最新的一次（只有最后一次 `begin()` 算最新）。 */
  isCurrent: (ticket: number) => boolean;
}

export function createReadingTickets(): ReadingTickets {
  let latest = 0;
  return {
    begin: () => {
      latest += 1;
      return latest;
    },
    isCurrent: (ticket) => ticket === latest,
  };
}
