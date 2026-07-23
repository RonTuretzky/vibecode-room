"use client";
import "../../chunk-FWCSY2DS.mjs";
import { createContext, useContext } from "react";
const ConnectedUserContext = createContext({
  user: {
    status: "LOADING"
  },
  isSafe: false
});
const useConnectedUser = () => {
  const context = useContext(ConnectedUserContext);
  if (context === void 0) {
    throw new Error(
      "useConnectedUser must be used within a ConnectedUserProvider"
    );
  }
  return context;
};
export {
  ConnectedUserContext,
  useConnectedUser
};
