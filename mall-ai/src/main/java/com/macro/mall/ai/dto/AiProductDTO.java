package com.macro.mall.ai.dto;

import lombok.Data;

import java.math.BigDecimal;
import java.util.List;

/**
 * 暴露给 AI Gateway 的商品精简结构。
 * 字段对齐 ai-gateway 内置样本（src/data/products.js），保证离线/在线数据可互换。
 */
@Data
public class AiProductDTO {
    private Long id;
    private String name;
    private String subtitle;
    private BigDecimal price;
    private BigDecimal originalPrice;
    private String pic;
    private Integer stock;
    private Integer sale;
    private String brand;
    private String category;
    private String description;
    private List<String> tags;
}
