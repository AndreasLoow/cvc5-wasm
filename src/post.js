// --post-js: convenience API carried by the instantiated module, so consumers
// call M.solve(script) instead of poking at ccall/malloc themselves.
Module["solve"] = function (script) {
  const text = script == null ? "" : String(script);
  const size = Module["lengthBytesUTF8"](text) + 1;
  const ptr = Module["_malloc"](size);
  if (!ptr) throw new Error("cvc5: out of memory copying the script in");
  try {
    Module["stringToUTF8"](text, ptr, size);
    return Module["UTF8ToString"](Module["_cvc5_solve"](ptr));
  } finally {
    Module["_free"](ptr);
  }
};

Module["reset"] = function () {
  Module["_cvc5_reset"]();
};

Module["version"] = function () {
  return Module["UTF8ToString"](Module["_cvc5_version"]());
};

// Current size of the wasm heap in bytes; used by the leak test.
Module["heapSize"] = function () {
  return Module["HEAPU8"] ? Module["HEAPU8"].length : wasmMemory.buffer.byteLength;
};
