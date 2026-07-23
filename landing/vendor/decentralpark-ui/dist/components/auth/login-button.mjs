"use client";
import {
  __objRest,
  __spreadProps,
  __spreadValues
} from "../../chunk-FWCSY2DS.mjs";
import { jsx } from "react/jsx-runtime";
import {
  LoginButtonPrivy
} from "./login-button-privy.mjs";
import { LoginButtonGeneral } from "./login-button-general.mjs";
import { useAuthProvider } from "../../context/lib.mjs";
const LoginButton = (_a) => {
  var _b = _a, {
    label = "Sign In"
  } = _b, props = __objRest(_b, [
    "label"
  ]);
  const authProvider = useAuthProvider();
  if (authProvider === "privy") {
    return /* @__PURE__ */ jsx(
      LoginButtonPrivy,
      __spreadProps(__spreadValues({}, props), {
        label
      })
    );
  }
  return /* @__PURE__ */ jsx(LoginButtonGeneral, __spreadProps(__spreadValues({}, props), { label }));
};
export {
  LoginButton
};
