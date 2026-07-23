import * as react from 'react';
import { ButtonHTMLAttributes } from 'react';
import { UseCopyToClipboardPayload } from '../../hooks/use-copy-to-clipboard.mjs';

interface CopyButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, UseCopyToClipboardPayload {
    checkedIconSize?: number;
}
declare const CopyButtonIcon: ({ children, textToCopy, checkedIconSize, ...buttonProps }: CopyButtonProps) => react.JSX.Element;

export { CopyButtonIcon as default };
