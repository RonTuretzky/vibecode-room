declare const LINKS: {
    readonly about: "https://decentralpark.nyc/about";
    readonly contact: "https://decentralpark.nyc/contact";
    readonly contributorForm: "https://decentralpark.nyc/contact";
    readonly dashboard: "https://decentralpark.nyc";
    readonly docs: "https://github.com/RonTuretzky/decentralparknyc";
    readonly donate: "https://etherscan.io/address/0xe6FA00D3aB17C619bC6A2CFc24994fB844aBdF96";
    readonly ens: "https://app.ens.domains/decentralparknyc.eth";
    readonly farcaster: "https://farcaster.xyz/decentralpark";
    readonly github: "https://github.com/RonTuretzky/decentralparknyc";
    readonly instagram: "https://instagram.com/decentralparknyc";
    readonly linkedin: "https://www.linkedin.com/company/decentral-park";
    readonly meetings: "https://decentralpark.nyc/meetings";
    readonly newsletter: "https://paragraph.com/@decentralpark";
    readonly partners: "https://decentralpark.nyc/partners";
    readonly pastMeetups: "https://decentralpark.nyc/past-meetups";
    readonly solidarityFund: "https://decentralpark.nyc";
    readonly stacks: "https://decentralpark.nyc/meetings";
    readonly telegram: "https://t.me/decentralparknyc";
    readonly twitter: "https://x.com/decentralparkny";
    readonly website: "https://decentralpark.nyc";
};
type LinkKey = keyof typeof LINKS;

export { LINKS, type LinkKey };
