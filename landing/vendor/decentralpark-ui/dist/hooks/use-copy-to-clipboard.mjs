"use client";
import "../chunk-FWCSY2DS.mjs";
import { useEffect, useState } from "react";
import { copyToClipboard } from "../utils/copy-to-clipboard.mjs";
const useCopyToClipboard = ({
  textToCopy
}) => {
  const [copied, setCopied] = useState(false);
  const timer = void 0;
  const copy = async () => {
    await copyToClipboard(textToCopy);
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
    }, 500);
  };
  useEffect(() => {
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, []);
  return { copied, copy };
};
export {
  useCopyToClipboard
};
