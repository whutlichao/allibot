import type { MessageKind, MessageMentionView } from '@allibot/shared';
import { createElement } from 'react';
import { renderMessageBody } from '../markdown.ts';

export interface MessageBodyProps {
  /** 消息的 kind：human / agent 是对话正文，system 是事件记录。 */
  kind: MessageKind;
  body: string;
  /** 后端给出的提及区间；组件只按区间包标签，不重新解析正文。 */
  mentions?: readonly MessageMentionView[];
}

/**
 * 一条消息正文的呈现：human / agent 按 Markdown 呈现在对话正文里，
 * `kind='system'` 的事件记录是事件行——不解析 Markdown、不套对话气泡。
 *
 * 这里用 createElement 而不是 JSX：Node 的类型剥离不处理 JSX，
 * 组件级 SSR 契约测试需要直接 import 本文件。
 */
export function MessageBody({ kind, body, mentions = [] }: MessageBodyProps) {
  if (kind === 'system') {
    return createElement(
      'div',
      {
        className: 'message-event',
        'data-message-kind': kind,
        role: 'note',
      },
      createElement('span', { className: 'message-event__text' }, body),
    );
  }

  return createElement('div', {
    className: 'message-body',
    'data-message-kind': kind,
    dangerouslySetInnerHTML: { __html: renderMessageBody(body, mentions) },
  });
}
