import { z } from 'zod';
import { badRequest } from '../../lib/errors.js';

/**
 * Tipos de benefício que o servidor SA-MP sabe entregar.
 * Cada tipo descreve os campos do formulário do painel (o administrador nunca edita JSON)
 * e o schema usado para validar os parâmetros no backend.
 */
export interface FieldMeta {
  key: string;
  label: string;
  kind: 'text' | 'integer' | 'select';
  required: boolean;
  help?: string;
  min?: number;
  max?: number;
  options?: { value: string; label: string }[];
}

export interface DeliveryTypeMeta {
  type: string;
  label: string;
  description: string;
  fields: FieldMeta[];
}

const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
const optionalInt = (min: number, max: number) =>
  z.preprocess((v) => (v === '' || v === null || v === undefined ? undefined : v), int(min, max).optional());
const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().max(max).optional());

const definitions = {
  vip: {
    label: 'VIP',
    description: 'Ativa um plano VIP na conta. A duração vem do campo "Duração" do produto (vazio = permanente).',
    fields: [
      { key: 'tier', label: 'Plano VIP', kind: 'text', required: true, help: 'Nome do plano reconhecido pelo servidor (ex.: bronze, prata, ouro).' },
    ],
    schema: z.object({ tier: text(40) }),
  },
  coins: {
    label: 'Moedas / créditos',
    description: 'Adiciona moedas ou créditos à conta.',
    fields: [
      { key: 'amount', label: 'Quantidade de moedas', kind: 'integer', required: true, min: 1, max: 100_000_000 },
      { key: 'currency', label: 'Tipo de moeda', kind: 'text', required: false, help: 'Opcional. Ex.: coins, cash. Vazio = moeda padrão do servidor.' },
    ],
    schema: z.object({ amount: int(1, 100_000_000), currency: optionalText(30) }),
  },
  vehicle: {
    label: 'Veículo',
    description: 'Entrega um veículo na garagem do jogador.',
    fields: [
      { key: 'model_id', label: 'Modelo (ID SA-MP)', kind: 'integer', required: true, min: 400, max: 611, help: 'ID do modelo de veículo do GTA SA (400 a 611).' },
      { key: 'color1', label: 'Cor primária', kind: 'integer', required: false, min: 0, max: 255 },
      { key: 'color2', label: 'Cor secundária', kind: 'integer', required: false, min: 0, max: 255 },
    ],
    schema: z.object({ model_id: int(400, 611), color1: optionalInt(0, 255), color2: optionalInt(0, 255) }),
  },
  property: {
    label: 'Propriedade',
    description: 'Concede uma casa ou empresa.',
    fields: [
      {
        key: 'property_type', label: 'Tipo', kind: 'select', required: true,
        options: [{ value: 'house', label: 'Casa' }, { value: 'business', label: 'Empresa' }],
      },
      { key: 'property_id', label: 'ID da propriedade', kind: 'integer', required: false, min: 1, max: 1_000_000, help: 'Opcional. Vazio = o servidor escolhe uma disponível.' },
    ],
    schema: z.object({ property_type: z.enum(['house', 'business']), property_id: optionalInt(1, 1_000_000) }),
  },
  item: {
    label: 'Item',
    description: 'Adiciona um item ao inventário.',
    fields: [
      { key: 'item_id', label: 'ID do item', kind: 'text', required: true, help: 'Identificador do item no servidor.' },
      { key: 'amount', label: 'Quantidade', kind: 'integer', required: true, min: 1, max: 1_000_000 },
    ],
    schema: z.object({ item_id: text(60), amount: int(1, 1_000_000) }),
  },
  skin: {
    label: 'Skin / personalização',
    description: 'Libera uma skin ou personalização.',
    fields: [{ key: 'skin_id', label: 'ID da skin', kind: 'integer', required: true, min: 0, max: 20_000 }],
    schema: z.object({ skin_id: int(0, 20_000) }),
  },
  perk: {
    label: 'Benefício',
    description: 'Benefício genérico identificado por uma chave tratada pelo servidor (ex.: troca de nome).',
    fields: [
      { key: 'perk_key', label: 'Chave do benefício', kind: 'text', required: true, help: 'Ex.: name_change, extra_slot.' },
      { key: 'value', label: 'Valor', kind: 'text', required: false },
    ],
    schema: z.object({ perk_key: text(60), value: optionalText(120) }),
  },
} as const satisfies Record<string, { label: string; description: string; fields: FieldMeta[]; schema: z.ZodType }>;

type SimpleType = keyof typeof definitions;
export const SIMPLE_TYPES = Object.keys(definitions) as SimpleType[];
export const DELIVERY_TYPES = [...SIMPLE_TYPES, 'bundle'] as const;
export type DeliveryType = (typeof DELIVERY_TYPES)[number];

const bundleSchema = z.object({
  items: z
    .array(z.object({ type: z.enum(SIMPLE_TYPES as [SimpleType, ...SimpleType[]]), params: z.record(z.string(), z.unknown()) }))
    .min(1)
    .max(20),
});

export function deliveryTypesMeta(): DeliveryTypeMeta[] {
  const simple = SIMPLE_TYPES.map((type) => {
    const { label, description, fields } = definitions[type];
    return { type, label, description, fields: fields as unknown as FieldMeta[] };
  });
  return [
    ...simple,
    {
      type: 'bundle',
      label: 'Pacote',
      description: 'Combina vários benefícios em um único produto (ex.: VIP + moedas + veículo).',
      fields: [],
    },
  ];
}

/** Valida e normaliza os parâmetros de entrega de um produto. Lança 400 com mensagem amigável. */
export function validateDeliveryParams(type: string, params: unknown): Record<string, unknown> {
  if (type === 'bundle') {
    const parsed = bundleSchema.safeParse(params);
    if (!parsed.success) throw badRequest('invalid_delivery_params', 'Adicione ao menos um benefício válido ao pacote.');
    return {
      items: parsed.data.items.map((item, i) => ({
        type: item.type,
        params: validateSimple(item.type, item.params, `Item ${i + 1} do pacote`),
      })),
    };
  }
  if (!(SIMPLE_TYPES as string[]).includes(type)) {
    throw badRequest('invalid_delivery_type', 'Tipo de benefício inválido.');
  }
  return validateSimple(type as SimpleType, params, 'Parâmetros de entrega');
}

function validateSimple(type: SimpleType, params: unknown, label: string): Record<string, unknown> {
  const parsed = definitions[type].schema.safeParse(params ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const field = definitions[type].fields.find((f) => f.key === first?.path[0]);
    throw badRequest('invalid_delivery_params', `${label}: verifique o campo "${field?.label ?? first?.path.join('.')}".`);
  }
  // Remove chaves opcionais vazias para manter o payload limpo.
  return Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined));
}
