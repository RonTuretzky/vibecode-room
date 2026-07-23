import "../../chunk-FWCSY2DS.mjs";
import { jsx } from "react/jsx-runtime";
import React from "react";
const fontVariables = {
  parkDisplay: "--font-parkDisplay",
  parkBody: "--font-parkBody"
};
const Typography = ({ variant, children, className = "" }) => {
  const baseClasses = ["h1", "h2", "h3"].includes(variant) ? "font-parkDisplay" : "font-parkBody";
  const variantClasses = {
    h1: "text-h1",
    h2: "text-h2",
    h3: "text-h3",
    h4: "text-h4",
    h5: "text-h5",
    body: "text-body",
    caption: "text-caption"
  };
  const Component = variant.startsWith("h") ? variant : "p";
  return React.createElement(
    Component,
    {
      className: `${baseClasses} ${variantClasses[variant]} ${className}`.trim()
    },
    children
  );
};
const Heading1 = ({ children, className = "" }) => /* @__PURE__ */ jsx(Typography, { variant: "h1", className, children });
const Heading2 = ({ children, className = "" }) => /* @__PURE__ */ jsx(Typography, { variant: "h2", className, children });
const Heading3 = ({ children, className = "" }) => /* @__PURE__ */ jsx(Typography, { variant: "h3", className, children });
const Heading4 = ({ children, className = "" }) => /* @__PURE__ */ jsx(Typography, { variant: "h4", className, children });
const Heading5 = ({ children, className = "" }) => /* @__PURE__ */ jsx(Typography, { variant: "h5", className, children });
const Body = ({ children, className = "", bold = false }) => /* @__PURE__ */ jsx(
  Typography,
  {
    variant: "body",
    className: `${bold ? "text-body-bold" : ""} ${className}`.trim(),
    children
  }
);
const Caption = ({ children, className = "" }) => /* @__PURE__ */ jsx(Typography, { variant: "caption", className, children });
export {
  Body,
  Caption,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Heading5,
  Typography,
  fontVariables
};
