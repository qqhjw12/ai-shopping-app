package com.macro.mall.ai.service.impl;

import com.macro.mall.ai.dto.AiProductDTO;
import com.macro.mall.ai.service.AiProductService;
import com.macro.mall.mbg.mapper.PmsBrandMapper;
import com.macro.mall.mbg.mapper.PmsProductCategoryMapper;
import com.macro.mall.mbg.mapper.PmsProductMapper;
import com.macro.mall.mbg.model.PmsBrand;
import com.macro.mall.mbg.model.PmsProduct;
import com.macro.mall.mbg.model.PmsProductCategory;
import com.macro.mall.mbg.model.PmsProductExample;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.stream.Collectors;

@Service
public class AiProductServiceImpl implements AiProductService {

    @Autowired
    private PmsProductMapper productMapper;
    @Autowired
    private PmsBrandMapper brandMapper;
    @Autowired
    private PmsProductCategoryMapper categoryMapper;

    @Override
    public List<AiProductDTO> listProducts(Integer pageSize, Integer pageNum) {
        PmsProductExample example = new PmsProductExample();
        example.createCriteria().andDeleteStatusEqualTo(0).andPublishStatusEqualTo(1);
        if (pageSize != null && pageNum != null) {
            example.setLimit(pageSize);
            example.setOffset((long) pageNum * pageSize);
        }
        example.setOrderByClause("sort desc, id desc");
        return productMapper.selectByExample(example).stream()
                .map(this::toDto)
                .collect(Collectors.toList());
    }

    @Override
    public AiProductDTO getProduct(Long id) {
        PmsProduct p = productMapper.selectByPrimaryKey(id);
        return p == null ? null : toDto(p);
    }

    private AiProductDTO toDto(PmsProduct p) {
        AiProductDTO dto = new AiProductDTO();
        dto.setId(p.getId());
        dto.setName(p.getName());
        dto.setSubtitle(p.getSubTitle());
        dto.setPrice(p.getPrice());
        dto.setOriginalPrice(p.getOriginalPrice());
        dto.setPic(p.getPic());
        dto.setStock(p.getStock());
        dto.setSale(p.getSale());
        dto.setDescription(p.getDescription());
        if (p.getBrandId() != null) {
            PmsBrand brand = brandMapper.selectByPrimaryKey(p.getBrandId());
            if (brand != null) dto.setBrand(brand.getName());
        }
        if (p.getProductCategoryId() != null) {
            PmsProductCategory cat = categoryMapper.selectByPrimaryKey(p.getProductCategoryId());
            if (cat != null) dto.setCategory(cat.getName());
        }
        return dto;
    }
}
