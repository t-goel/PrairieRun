import { defineSchema, defineTable } from "convex/server";
import { authTables } from "@convex-dev/auth/server";
import { v } from "convex/values";

export default defineSchema({
  ...authTables,
  feeds: defineTable({
    userId: v.id("users"),
    feedId: v.string(),
    createdAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_feedId", ["feedId"]),
});
