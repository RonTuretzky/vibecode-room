import * as react from 'react';
import { ReactNode } from 'react';
import { Address, Abi } from 'viem';
import { App } from '../interface/app.mjs';

type AuthProvider = "privy" | "general";
type TokenConfig = {
    PARK: {
        address: Address;
        abi: Abi;
    };
};
type ParkUIKitContextType = {
    chainId: number;
    tokenConfig: TokenConfig;
    app: App;
    authProvider: AuthProvider;
};
declare const ParkUIKitContext: react.Context<ParkUIKitContextType | undefined>;
declare const ParkUIKitProvider: ({ chainId, tokenConfig, children, app, authProvider, }: {
    chainId: number;
    tokenConfig: TokenConfig;
    app: App;
    authProvider: AuthProvider;
    children: ReactNode;
}) => react.JSX.Element;
declare const useParkUIKitContext: () => ParkUIKitContextType;
declare const useAuthProvider: () => AuthProvider;

export { ParkUIKitContext, ParkUIKitProvider, useAuthProvider, useParkUIKitContext };
