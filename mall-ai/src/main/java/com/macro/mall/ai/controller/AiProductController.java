package com.macro.mall.ai.controller;

import com.macro.mall.ai.dto.AiProductDTO;
import com.macro.mall.ai.service.AiProductService;
import com.macro.mall.common.api.CommonResult;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * 暴露给 AI Gateway 回调的只读商品接口。
 * 该路径需在 mall-admin 的 SecurityConfig 中设为 permitAll（见 README）。
 */
@RestController
@RequestMapping("/api/ai/products")
public class AiProductController {

    @Autowired
    private AiProductService productService;

    @GetMapping
    public CommonResult<List<AiProductDTO>> list(
            @RequestParam(required = false, defaultValue = "20") Integer pageSize,
            @RequestParam(required = false, defaultValue = "0") Integer pageNum) {
        return CommonResult.success(productService.listProducts(pageSize, pageNum));
    }

    @GetMapping("/{id}")
    public CommonResult<AiProductDTO> detail(@PathVariable Long id) {
        AiProductDTO dto = productService.getProduct(id);
        if (dto == null) {
            return CommonResult.failed("商品不存在");
        }
        return CommonResult.success(dto);
    }
}
