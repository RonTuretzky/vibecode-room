"use client";
import "../chunk-FWCSY2DS.mjs";
import { formatUnits } from "viem";
import { useBlock, useReadContract } from "wagmi";
import { useParkUIKitContext } from "../context/lib.mjs";
import { useEffect, useMemo } from "react";
const useParkBalance = ({ address }) => {
  const { tokenConfig, chainId } = useParkUIKitContext();
  const { data: blockNumber } = useBlock({ watch: true, chainId });
  const {
    data: balance,
    refetch: refetchBalance,
    isLoading
  } = useReadContract({
    address: tokenConfig.PARK.address,
    abi: tokenConfig.PARK.abi,
    functionName: "balanceOf",
    args: [address],
    chainId
  });
  useEffect(() => {
    refetchBalance();
  }, [blockNumber]);
  const PARK = useMemo(() => {
    if (!balance) return "0.00";
    return formatUnits(balance, 18);
  }, [balance]);
  return { PARK, refetchBalance, isLoading };
};
export {
  useParkBalance
};
