import react__default from 'react';

declare const fontVariables: {
    readonly parkDisplay: "--font-parkDisplay";
    readonly parkBody: "--font-parkBody";
};
declare const Typography: react__default.FC<{
    variant: "h1" | "h2" | "h3" | "h4" | "h5" | "body" | "caption";
    children: react__default.ReactNode;
    className?: string;
}>;
declare const Heading1: react__default.FC<{
    children: react__default.ReactNode;
    className?: string;
}>;
declare const Heading2: react__default.FC<{
    children: react__default.ReactNode;
    className?: string;
}>;
declare const Heading3: react__default.FC<{
    children: react__default.ReactNode;
    className?: string;
}>;
declare const Heading4: react__default.FC<{
    children: react__default.ReactNode;
    className?: string;
}>;
declare const Heading5: react__default.FC<{
    children: react__default.ReactNode;
    className?: string;
}>;
declare const Body: react__default.FC<{
    children: react__default.ReactNode;
    className?: string;
    bold?: boolean;
}>;
declare const Caption: react__default.FC<{
    children: react__default.ReactNode;
    className?: string;
}>;

export { Body, Caption, Heading1, Heading2, Heading3, Heading4, Heading5, Typography, fontVariables };
