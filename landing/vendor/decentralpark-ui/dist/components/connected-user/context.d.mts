import * as react from 'react';
import { TConnectedUserState } from './interface.mjs';
import 'viem';

declare const ConnectedUserContext: react.Context<{
    user: TConnectedUserState;
    isSafe: boolean;
}>;
declare const useConnectedUser: () => {
    user: TConnectedUserState;
    isSafe: boolean;
};

export { ConnectedUserContext, useConnectedUser };
