import { Connector } from 'wagmi';

declare function useAutoConnect(activeConnector: Connector | undefined): {
    isSafe: boolean;
    isConnected: boolean;
};

export { useAutoConnect };
