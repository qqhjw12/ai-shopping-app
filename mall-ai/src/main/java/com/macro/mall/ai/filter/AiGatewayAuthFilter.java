package com.macro.mall.ai.filter;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import javax.servlet.FilterChain;
import javax.servlet.ServletException;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import java.io.IOException;

/**
 * 可选的内部鉴权：当配置了 ai.gateway-key 时，
 * 只有携带正确 X-AI-Gateway-Key 头（由 ai-gateway 在回调时带上）的请求才放行。
 * 未配置则放行（此时必须依赖内网隔离保护该端点）。
 */
@Component
@Order(1)
public class AiGatewayAuthFilter extends OncePerRequestFilter {

    @Value("${ai.gateway-key:}")
    private String gatewayKey;

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        if (!request.getRequestURI().startsWith("/api/ai/")) {
            chain.doFilter(request, response);
            return;
        }
        if (gatewayKey == null || gatewayKey.isEmpty()) {
            chain.doFilter(request, response);
            return;
        }
        String provided = request.getHeader("X-AI-Gateway-Key");
        if (gatewayKey.equals(provided)) {
            chain.doFilter(request, response);
            return;
        }
        response.setStatus(HttpServletResponse.SC_FORBIDDEN);
        response.setContentType("application/json;charset=UTF-8");
        response.getWriter().write("{\"error\":\"forbidden\"}");
    }
}
