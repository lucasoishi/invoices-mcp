/**
 * A FAKE Itaú statement (invented merchants, invented amounts) laid out the way real statements read:
 * summary block, payments, purchases where each row is followed by a "category CITY" line, a page break
 * with "continua..." and a repeated header, an installment, a cancelled purchase, international purchases
 * with conversion rates, IOF, and the "future installments" section that must NOT be counted.
 *
 * Arithmetic (so tests can assert it independently):
 *   purchases   138,84 + 14,00 + 45,97 + 37,95 + 1.850,00 - 1.850,00 + 507,34 + 120,25 = 864,35
 *   international 67,14 + 688,67 = 755,81     IOF 30,54     -> 786,35
 *   total of current charges                                  1.650,70
 */
export const ITAU_PAGE_1 = [
  "Resumo da fatura em R$",
  "Total da fatura anterior 1.000,00",
  "Pagamento efetuado em 01/09/2026 -1.000,00",
  "Vencimento: 01/10/2026",
  "Total desta fatura 1.650,70",
  "Emissão: 24/09/2026",
  "Titular TITULAR FICTICIO Cartão 0000.XXXX.XXXX.0000",
  "O pagamento obrigatório é composto pelo saldo do crédito rotativo. Veja seu contrato no site Itaú Cartões.",
  "Pagamentos efetuados DATA VALOR EM R$",
  "01/09 PAGAMENTO DEB AUTOMATIC -1.000,00",
  "Total dos pagamentos -1.000,00",
  "Lançamentos: compras e saques TITULAR FICTICIO",
  "DATA ESTABELECIMENTO VALOR EM R$",
  "20/05 LOJA UM 05/06 138,84",
  "viagem CIDADE UM",
  "26/08 CAFE EXEMPLO 14,00",
  "restaurante CIDADE DOIS",
  "27/08 FARMACIA EXEMPLO 45,97",
  "HEALTH CIDADE DOIS",
  "27/08 APP DE TRANSPORTE 37,95",
  "transporte Sao Paulo",
  "02/09 HOTEL EXEMPLO 1.850,00",
  "HOTEL CIDADE TRES",
  "02/09 CANCELAMENTO DE COMPRA -1.850,00",
  "HOTEL CIDADE TRES",
  "continua...",
  "1",
];

export const ITAU_PAGE_2 = [
  "Lançamentos: compras e saques TITULAR FICTICIO",
  "DATA ESTABELECIMENTO VALOR EM R$",
  "04/09 LOJA DOIS 01/03 507,34",
  "HOTEL CIDADE QUATRO",
  "05/09 MERCADO EXEMPLO 120,25",
  "SUPERMARKET CIDADE QUATRO",
  "Lançamentos no cartão 864,35",
  "Lançamentos internacionais TITULAR FICTICIO DATA ESTABELECIMENTO US$ R$",
  "25/08 SERVICO EXTERIOR UM 67,14",
  "8,99 GBP 12,32 Dólar de Conversão R$ 5,45",
  "31/08 SERVICO EXTERIOR DOIS 688,67",
  "651,94 BRL 125,67 Dólar de Conversão R$ 5,48",
  "Total transações inter. em R$ 755,81",
  "Repasse de IOF em R$ 30,54",
  "Total lançamentos inter. em R$ 786,35",
  "Total dos lançamentos atuais 1.650,70",
  "Compras parceladas - próximas faturas DATA ESTABELECIMENTO VALOR EM R$",
  "20/05 LOJA UM 06/06 138,84",
  "04/09 LOJA DOIS 02/03 507,33",
  "Próxima fatura 646,17",
  "Limite total de crédito 16.500,00",
];

export const itauLines = (): string[] => [...ITAU_PAGE_1, ...ITAU_PAGE_2];
export const itauText = (): string => itauLines().join("\n");
