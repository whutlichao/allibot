import { type AgentStatus, type Locale } from '@allibot/shared';
import { createElement } from 'react';
import { statusLabel } from './status-label.ts';

export interface StatusPointProps {
  status: AgentStatus;
  locale: Locale;
}

/**
 * 状态点（Status Point）的唯一呈现：四态来自后端事实，前端只按取值取
 * 词条与图形档 token（`.status-point[data-status]`）。
 */
export function StatusPoint({ status, locale }: StatusPointProps) {
  const label = statusLabel(locale, status);
  return createElement(
    'span',
    {
      className: 'status-point',
      'data-status': status,
      title: label,
    },
    label,
  );
}
