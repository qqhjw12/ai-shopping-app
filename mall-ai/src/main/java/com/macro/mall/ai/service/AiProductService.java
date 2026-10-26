package com.macro.mall.ai.service;

import com.macro.mall.ai.dto.AiProductDTO;

import java.util.List;

public interface AiProductService {
    /**
     * 列出已上架、未删除的商品（供 AI Gateway 检索 / 同步进 Dify 知识库）。
     */
    List<AiProductDTO> listProducts(Integer pageSize, Integer pageNum);

    /**
     * 单个商品详情。
     */
    AiProductDTO getProduct(Long id);
}
