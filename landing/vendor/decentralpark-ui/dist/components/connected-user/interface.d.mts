import { Hex, Chain } from 'viem';

type TUserLoading = {
    status: "LOADING";
};
type TUserNotConnected = {
    status: "NOT_CONNECTED";
};
type TUserConnected = {
    status: "CONNECTED" | "UNSUPPORTED_CHAIN";
    address: Hex;
    chain: Chain;
};
type TConnectedUserState = TUserLoading | TUserNotConnected | TUserConnected;

export type { TConnectedUserState, TUserConnected, TUserLoading, TUserNotConnected };
