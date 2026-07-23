interface UseCopyToClipboardPayload {
    textToCopy: string;
}
declare const useCopyToClipboard: ({ textToCopy, }: UseCopyToClipboardPayload) => {
    copied: boolean;
    copy: () => Promise<void>;
};

export { type UseCopyToClipboardPayload, useCopyToClipboard };
