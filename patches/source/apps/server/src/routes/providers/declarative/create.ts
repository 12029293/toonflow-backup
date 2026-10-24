import { Router } from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { createDeclarativeProviderSource } from "@/utils/media/declarative";

export default Router().post("/", async (req, res) => {
  // ACT: 表单生成供应商源码后走既有 addMediaProvider，保留校验、加锁与版本语义。
  const source = createDeclarativeProviderSource(req.body);
  res.json(success(await u.mediaProvider.addMediaProvider(source)));
});
