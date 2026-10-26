package com.macro.mall.ai;

import org.mybatis.spring.annotation.MapperScan;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * mall-ai 独立启动类。
 *
 * 该模块是一个【只读的 AI 集成服务】，独立占用 8081 端口，直连 mall 数据库，
 * 仅向 ai-gateway 暴露 GET /api/ai/products 与 /{id}，不改动商城内核。
 * 编译时作为 mall fork 的一个 Maven 模块（mvn -pl mall-ai -am package）。
 */
@SpringBootApplication
@MapperScan("com.macro.mall.mbg.mapper")
public class MallAiApplication {

    public static void main(String[] args) {
        SpringApplication.run(MallAiApplication.class, args);
    }
}
