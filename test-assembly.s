/*
 * Assembly-language mirror of the WebSMART widget markup.
 * Note: studentportal-update/test.html is empty in this repo; content matches
 * studentportal-update/test-copy.html (widget block).
 *
 * Assemble (Apple clang, arm64): clang -c test-assembly.s -o test-assembly.o
 */

    .section    __TEXT,__cstring,cstring_literals

/* --- div.widget-block --- */
L_cls_root:
    .asciz  "col-sm-6 col-md-6 col-lg-4 col-xl-4 widget-block"
L_cls_inner:
    .asciz  "widget-block-inner"
L_cls_thumb:
    .asciz  "widget-block-thumbnail"
L_href_websmart:
    .asciz  "https://websmart.smccd.edu"
L_title_visit:
    .asciz  "Visit WebSMART"
L_tabindex_thumb_link:
    .asciz  "-1"
L_aria_hidden:
    .asciz  "true"
L_img_src:
    .asciz  "images/websmart.jpg"
L_img_alt:
    .asciz  "WebSMART Screenshot"
L_cls_content:
    .asciz  "widget-block-content"
L_cls_header:
    .asciz  "widget-block-header"
L_cls_title:
    .asciz  "widget-block-title"
L_heading_text:
    .asciz  "WebSMART"
L_cls_excerpt:
    .asciz  "widget-block-excerpt"
L_excerpt_body:
    .asciz  "A web resource for viewing college data.\n        Students can register for classes,\n        download transcripts,\n        apply for financial aid and much more!\n"
L_cls_links:
    .asciz  "widget-block-links"
L_cls_btn:
    .asciz  "btn btn-block btn-primary"
/* "Visit" + line break + spaces + "WebSMART" + two NBSP (U+00A0) as in HTML */
L_btn_label:
    .asciz  "Visit\n        WebSMART\xc2\xa0\n        \xc2\xa0\n        "
L_cls_fa_span:
    .asciz  "fa fa-angle-right"

    .section    __TEXT,__const
    .align      3
/* Optional table of pointers to cstrings (same layout order as DOM walk) */
    .globl      _websmart_widget_strings
_websmart_widget_strings:
    .quad       L_cls_root
    .quad       L_cls_inner
    .quad       L_cls_thumb
    .quad       L_href_websmart
    .quad       L_title_visit
    .quad       L_tabindex_thumb_link
    .quad       L_aria_hidden
    .quad       L_img_src
    .quad       L_img_alt
    .quad       L_cls_content
    .quad       L_cls_header
    .quad       L_cls_title
    .quad       L_href_websmart
    .quad       L_title_visit
    .quad       L_heading_text
    .quad       L_cls_excerpt
    .quad       L_excerpt_body
    .quad       L_cls_links
    .quad       L_href_websmart
    .quad       L_title_visit
    .quad       L_cls_btn
    .quad       L_btn_label
    .quad       L_cls_fa_span

    .section    __DATA,__data
    .globl      _websmart_widget_string_count
    .align      2
_websmart_widget_string_count:
    .long       23
