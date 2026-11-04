import { t, type Locale } from '@allibot/shared';
import type { CopilotChatLabels } from '@copilotkit/react-core/v2';

/**
 * The two CopilotKit labels the workspace overrides. Both CopilotKit entries
 * (the production `CopilotChat` and the standalone workbench) read the same
 * workspace catalog, so neither falls back to the framework's English copy.
 */
export function workspaceChatLabels(locale: Locale): Partial<CopilotChatLabels> {
  return {
    chatInputPlaceholder: t(locale, 'workspace.composer.placeholder'),
    chatDisclaimerText: t(locale, 'workspace.chat.disclaimer'),
  };
}
