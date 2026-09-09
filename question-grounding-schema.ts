import { Type } from "typebox";

const QuestionBasisSchema = Type.Object({
  kind: Type.Union([
    Type.Literal("objective"),
    Type.Literal("key-point"),
    Type.Literal("prerequisite"),
  ]),
  value: Type.String({ minLength: 1, maxLength: 500 }),
  supports: Type.Array(Type.Integer({ minimum: 1, maximum: 12 }), { minItems: 1, maxItems: 12 }),
  prerequisiteBasis: Type.Optional(Type.Union([
    Type.Literal("ordinary"),
    Type.Literal("source-declared"),
  ])),
  sourcePage: Type.Optional(Type.Integer({ minimum: 1 })),
});

export const QuestionGroundingSchema = Type.Object({
  purpose: Type.Union([
    Type.Literal("diagnostic"),
    Type.Literal("practice"),
    Type.Literal("mastery"),
  ]),
  competency: Type.String({ minLength: 1, maxLength: 500 }),
  requiredEvidence: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 12 }),
  sourcePages: Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1, maxItems: 24 }),
  basis: Type.Array(QuestionBasisSchema, { minItems: 1, maxItems: 24 }),
});
